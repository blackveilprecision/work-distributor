# How wd works

The shared types for everything below are in [`src/shared/types.ts`](../src/shared/types.ts).

## Pieces
| Piece | Code | Runs | Owns |
|---|---|---|---|
| Coordinator | `src/coord/` | one host, `wd coord` | the SQLite database (the only writer), the caller API, the scheduler, reports |
| Agent | `src/agent/` | every host, `wd agent` | repo mirrors, worktrees, turn processes, the event tailer, branch pushes |
| CLI | `src/cli/` | anywhere | a thin client of the caller API, plus the installers: `wd coord install`, `wd host install`, `wd init-local` |
| MCP server | `src/mcp/` | inside a Claude Code session, `wd mcp` | forwards the `wd_*` tools (defined in `src/coord/tools.ts`) and the report channel |
| Plugin | `plugin/` | Claude Code | `.mcp.json`, the hooks and the skill |

Everything is one binary (`src/main.ts`), compiled with `bun build --compile`.

## Threads, turns and epochs
- **Thread:** one Claude session working on one branch (`wd/<id>` unless one is given) in one worktree on one host.
- **Turn:** one `claude -p` process.
  - Turn 1 runs with `--session-id`.
  - Later turns, started by `send`, run with `--resume` on the same host.
- **Epoch:** a number that increases every time a thread is placed or resumed. Every message between agent and coordinator carries it.
  - The coordinator rejects anything with an old epoch.
  - When an agent reconnects, it is told to stop turns whose epoch was replaced.
  - So a host that comes back after being declared lost cannot report or push stale work.

States: `queued → running → idle → done`, with side exits `failed`, `lost`, `stalled` and `cancelled`.
- `idle`: the last turn finished, a report was sent, and the worktree is kept for `send`.
- `done`: the caller released the thread, or its TTL (default 24 h) passed after the last turn.
- Final threads have their worktree removed 24 h after they end.

## Placement
The scheduler ticks every `tickMs` (default 5 s). It considers queued threads with priority threads first, then oldest first. A host qualifies when all of these hold:
- its state is `ok`;
- it has every label the thread `requires` (a host's own name counts as a label, so `requires: ["bazzite"]` pins a thread to bazzite);
- the repo's `doctor` command passed on it. The coordinator asks the agent to run the doctor when the host first appears, again after 24 h, and after 10 min if it failed. The doctor runs with the same PATH as the turns (see Running a turn);
- if it sets `maxThreads` (an optional cap; there is none by default), its running turns are fewer;
- its free disk is at least `floors.diskFreePct` (default 15%);
- its available memory, minus reservations, covers the memory estimate plus `floors.memReserveMb` (default 2048);
- its CPU in use or promised (the 1-minute load average plus the CPU reservations), plus the CPU estimate, is at most its cores times `floors.cpuOversub` (default 1.5). The load average counts everything on the host: other turns, work a turn started outside its own process group or unit (`hc run`), and the owner's own use. CPU contention slows turns down rather than killing them, which is why a host may be committed past its cores. An estimate above a host's core count asks for all of its cores there (and is promised that much), since a turn cannot use more; it runs slower there instead of never starting.

The thread goes to the qualifying host where it would run fastest: the host's single-core speed times the share of the cores it wants that are free there. Speed is a benchmark each agent runs when it starts and every 10 minutes after (sorting and a JSON round trip, best of three 200 ms runs); `cpuScore` is the best result so far, kept in `<dataDir>/speed` across restarts, because a busy host benchmarks slow and a host never gets faster. Among hosts within 5% of the best, the one with the most memory left over wins. More rules:
- **Estimate:** two numbers per repo, each the p90 over its last 20 turns, but never less than the size hint:
  - memory: each turn's peak; at least 2048 MB for `small` (the default) and 8192 MB for `heavy`;
  - CPU: each turn's highest rate over a one-minute window, in cores, from the CPU time the agent reports every heartbeat (a turn's last partial window counts if it was at least 15 s, and a shorter turn counts its average); at least 0.5 cores for `small` and 2 for `heavy`. A minute, because a turn mostly waits on the model and then a build takes every core for a while: its average says little about what it needs.

  Light turns of a repo cannot shrink a heavy thread's estimate this way, or its memory cap. So light turns of a repo cannot shrink a heavy thread's estimate, or the memory cap that comes from it (twice the estimate). An out-of-memory kill raises it. The cap is per turn: it stops one runaway command before it takes the host's memory from the other threads, so a turn can be killed while the host still has plenty free. The failure reason names the cap, the estimate and the step that was running.
- **Memory cap:** twice the memory estimate. An out-of-memory kill raises the estimate. The cap is per turn: it stops one runaway command before it takes the host's memory from the other threads, so a turn can be killed while the host still has plenty free. The failure reason names the cap, the estimate and the step that was running.
- **Reservations:** every running turn on a host counts the part of its estimates it is not using against that host, however long it has run: for memory, its estimate minus its peak so far; for CPU, its estimate minus its rate over the last minute. The probe only shows what turns use now; a build that peaks later must not find its memory or cores given to another thread.
- **Follow-ups** go through the same checks on their thread's host, and wait there for room.

A thread that fits nowhere stays queued, and later threads can still be placed past it. `GET /queue` (`wd queue`) runs the same checks without placing anything and says, for each queued thread and each pending follow-up, why it has not started: the usage-limit hold, or each host's first failing check (`lacks label gpu`, `cpu 11.6 of 8 cores busy or promised, needs 0.5`, `doctor failed: bun: not found`, `memory 3000 MB free, needs 2048+2048`, …). `GET /hosts` lists each host's failing doctors (`doctorFailed`), and `GET /hosts?repo=<id>` (`wd hosts --repo`) adds `why`: the same check for a new thread of that repo on each host, `null` when it would start there.. `null` means it starts on the next tick.

When an agent reports a `rate_limit_event` with status `rejected`, all new starts are held until the reset time. The hold is reported to the affected callers. A limit reset early (by the account owner) is not visible to wd: `DELETE /hold` (`wd hold --clear`) ends the hold, and `wd hold` shows it.

## Running a turn (agent)
1. Fetch or clone the mirror at `~/.wd/repos/<owner>__<repo>.git`, then create or reuse the worktree at `~/.wd/wt/<thread>`.
2. For repos marked `rust`, lease a target directory from a pool of `targetDirPool` per repo, and set `RUSTC_WRAPPER=sccache` if sccache is installed and no cargo config the turn reads (`~/.cargo/config.toml` or the repo's `.cargo/config.toml`) already names a `rustc-wrapper`: the variable would override that choice (kache, for one).
3. Write `~/.wd/turns/<thread>-<epoch>-<turn>/run.sh`. It runs `claude` under `env -i` with this fixed environment:
   - HOME, USER, LOGNAME, `SHELL=/bin/bash`;
   - PATH: `path` from `agent.json`, or else the PATH an interactive login shell of the host user prints (`$SHELL -lic`, bash or zsh), read once when the agent starts, followed by the service's own. Tools that add themselves only in `~/.bashrc` or `~/.zshrc` (bun, nvm) are found this way;
   - a per-thread `TMPDIR` inside the worktree;
   - `WD_THREAD`, `WD_KEY`;
   - `DISABLE_AUTOUPDATER=1`.

   It never passes `GH_TOKEN`, `GITHUB_TOKEN` or `SSH_AUTH_SOCK`.

   ```
   claude -p --output-format stream-json --verbose (--session-id|--resume) <id>
     --setting-sources user --strict-mcp-config
     --settings '{"crossSessionInbound":"refuse",...}' --dangerously-skip-permissions [--model m]
   ```
4. Start it:
   - **Linux:** as `systemd-run --user --unit wd-<thread>-<epoch>-<turn>` with `MemoryMax` and `RuntimeMaxSec`. CPU and peak memory come from the unit, plus what the turn started outside it: processes whose working directory is in the turn's worktree, and their descendants (an `hc run` terminal is started by the hc server, outside the unit). Those are measured every 5 s but not moved into the unit, so the unit's end does not kill work the thread left running on purpose, and the memory cap does not cover them.
   - **macOS:** in its own process group, with a wall-clock limit. The turn is that group and every descendant of it, since Claude Code runs each Bash command in a process group of its own; CPU and memory are sampled from all of them, and stopping the turn kills all of them. A process whose parent exits is reparented to launchd and drops out (sccache's server, for one).

   Turns outlive agent restarts.
5. Tail `out.jsonl` from a saved byte offset. Lines can be any length; each is cut to 8000 characters after it is read. Batches go to the coordinator, and the offset only moves forward to what the coordinator committed, so every event is stored once, with the time its batch arrived. `GET /threads/:id/steps` and the `activity` in `GET /queue` summarise them: a tool call by its main input (`Bash: bun test`), text on one line, a result as `↳ ...`.
6. When the turn exits:
   - read the `result` line (`is_error`, result text, cumulative cost);
   - commit anything left uncommitted;
   - if the branch is ahead of its base, push it with `--force-with-lease`, using the token in `gitTokenFile`. While a turn runs, the branch is also pushed every 10 min;
   - send the turn end. It is retried until the coordinator accepts it.

The `/start` request returns at once; cloning and launching happen in the background. A launch failure becomes a `launch-failed` turn end.

## Reports and delivery
A report is a stored row for the submitting caller. One is written:
- when a turn ends: kind `turn`, with the thread now `idle`;
- when a thread reaches a final state: kind `final`;
- for events the caller should know about mid-thread: the host fell asleep, the usage limit is holding starts, or the thread is resuming after a host restart.

A report holds:
- state and host;
- `isError`;
- the final message, cut at 4000 characters, and `truncated` when it was cut (`GET /threads/:id?full=1` has all of it);
- branch, head SHA and whether it was pushed;
- the turn's cost and wall time;
- for failures, the reason.

Reports stay until acknowledged. There are four ways to get them:
- **Webhook:** `PUT /callers/<name> {"webhook": url}`. Reports are POSTed with retries and backoff, and acknowledged on a 2xx.
- **SSE:** `GET /reports/stream?caller=` sends the unacknowledged backlog, then new reports as they come.
- **Polling or the CLI:** `GET /reports?caller=` or `wd reports --pending`. The caller acknowledges with `POST /reports/<id>/ack` or `wd ack`.
- **Plugin:**
  - `wd mcp` holds the SSE stream open and turns each report into a `notifications/claude/channel` event, with meta `{report, thread, state, kind, tag}`. Pushing never acknowledges, because Claude Code silently drops channel events when the session was started without the channel flag. The agent calls `wd_ack` once it has acted on the report.
  - The tools are not in `wd mcp`, which lives as long as its session: it lists them with `GET /mcp/tools` and runs them with `POST /mcp/call` `{name, arguments, caller}`, which maps each tool onto a caller route. When the report stream reconnects (after a coordinator restart) it lists them again and, if they changed, sends `notifications/tools/list_changed`. So a new coordinator changes the tools of every open session; only a change to `wd mcp` itself needs the session restarted.
  - The plugin's `SessionStart` and `UserPromptSubmit` hooks add any unacknowledged reports to the context and acknowledge them, so a report that missed the channel arrives with the next prompt.

## Failure handling
| What happens | Result |
|---|---|
| Launch error (clone failed, `claude` missing, bad args) | `failed` with the error; never retried |
| No heartbeat for `lostAfterSec` (default 120 s) from a Linux host | host `lost`; its threads `lost`; their turns are stopped when the host returns |
| No heartbeat from a macOS host | host `asleep`, with a non-final report; its threads become `lost` after `asleepLostSec` (default 6 h) |
| No events and no CPU use for `stallMin` (default 20 min) | turn stopped; thread `stalled`. A long build with no output still uses CPU, so it is not a stall |
| Out-of-memory kill or `RuntimeMaxSec` reached | `failed` with the cause |
| Turn process vanished without exiting (host restart) | resumed once on the same host with "You were interrupted by a host restart"; a second time in a row gives `lost` |
| Agent restart | nothing: turns keep running and the tailer picks them up |
| Coordinator restart | nothing: agents buffer and resend events and turn ends; CLI and tool calls retry a refused connection for 20 seconds; the report stream reconnects |

## Cleanup
- **Release:** `release`, an expired TTL, or a final thread 24 h old makes the agent remove the worktree and its tmp dir and free its target lease. The branch on origin stays. A `release` writes no report: the caller asked for it. A TTL expiry does write a `final` one.
- **Orphan sweep:** at start and every 6 h, each agent asks the coordinator which threads are still live. It then removes worktrees, turn dirs and leases that belong to no live thread, are more than 24 h old and have no running process. If the coordinator can't be reached, the sweep does nothing.

## Host checks
Every heartbeat (15 s) carries the agent's probe:
- OS, cores, total and available memory, free disk;
- `claude --version`;
- a headless login check, cached for an hour;
- on Linux, lingering and cgroup v2.

A host with any problem is `refused`, and the reason is shown in `wd hosts`.

## API
All routes take `authorization: Bearer <token>`.
- **Caller routes** use `callerToken`:
  - `POST /threads`, `GET /threads?caller=`, `GET /threads/:id` (`?full=1`: `lastMessage` uncut, and `messages`, every turn's whole text);
  - `POST /threads/:id/send|cancel|release`;
  - `GET /reports?caller=&after=`, `GET /reports/stream?caller=`, `POST /reports/:id/ack`;
  - `PUT /callers/:name`;
  - `GET /hosts`: the state of every known host (config and registered), with its failing doctors; `?repo=<id>` adds `why` per host;
  - `GET /queue`: across all callers, the queued threads in placement order (with the start of each prompt) and pending follow-ups (with their text), each with why it waits; idle threads with their last message; and every host with its running threads, each one's latest step (`activity`), and for every repo why a new thread of it could not start there (`repos`, `null` when it could) (`QueueView` in `types.ts`);
  - `GET /threads/:id/steps?n=&turn=&after=`: a turn's recent steps, summarised from its stored events (`Steps`); pass the returned `next` as `after` for only newer ones (`wd tail`);
  - `GET /repos`, `PUT /repos/:id`, `DELETE /repos/:id`: repos registered at runtime (see below). The id may contain `/`; the CLI URL-encodes it (`acme%2Fshop`);
  - `PUT /hosts/:name`, `DELETE /hosts/:name`: hosts registered at runtime (see below).
- **Agent routes** use the host's token:
  - `POST /agent/heartbeat`, `POST /agent/events`, `POST /agent/turn-end`;
  - `GET /agent/threads?host=`.
- **Routes on the agent** (port 7781) use the host token: `POST /start|stop|release|doctor`, `GET /probe`.
- **`GET /healthz`** on the coordinator needs no token.

### Registering hosts and repos
Hosts and repos can be listed in `coord.json` or registered through the caller API; the coordinator keeps the registered ones in its database. The scheduler and the agent authentication read the merged set on every use, so a registration works at once, with no restart. When an id is in both, `coord.json` wins.
- `PUT /repos/:id` with `{url, defaultRef?, doctor?, requires?, rust?}` replaces the repo and returns it with `source` (`db`, or `config` when `coord.json` has the id, in which case nothing changes). `defaultRef` is `main` by default. Changing a repo clears its stored doctor results. `DELETE` removes it (409 for a `coord.json` repo). A thread already queued or idle for a removed repo fails with "no longer configured".
- `PUT /hosts/:name` with `{url}` (the agent's `http://host:7781`) generates a host token and returns `{name, url, token, source}`. A second `PUT` keeps the token and updates the url, but does not return the token; `{rotate: true}` replaces it and returns the new one. A token is only ever returned when it was just created or rotated. For a `coord.json` host it returns `{name, url, source: "config"}` (no token) and changes nothing. The caller token is an admin credential: it can register, rotate and repoint hosts. `DELETE` removes the registration and the host's state (409 for a `coord.json` host, or while a turn runs on it).
- `wd repo add|ls|rm` and `wd host install` use these routes.

## Installing
- `wd coord install <ssh-host|local>` and `wd host install <ssh-host|local>` (`src/cli/install.ts`) run on the machine you build from, through a `Target` that runs a shell command either over ssh or locally, copies a file, and builds the binary (`bun build --compile` for the target's OS and arch, from the source checkout). Tests replace the `Target`.
- Both install `~/.local/bin/wd`, write the config unless it exists, and install and start a service: `wd-coord`/`wd-agent` systemd user units on Linux (with lingering), `wd.coord`/`wd.agent` LaunchAgents in the `gui/<uid>` domain on macOS.
- `coord install` writes `coord.json` with a random `callerToken` and `listen` on the machine's Tailscale IPv4 (else `127.0.0.1`), port 7780, waits for `/healthz`, and writes the local `client.json` (`url` and `token`, no `caller`: a fixed one would share one inbox across all sessions) unless it exists, in which case it warns if that file or `WD_CLIENT_CONFIG` names a different coordinator.
- `host install` checks what it can refuse (loopback coordinator url, no Tailscale address and no `--agent-url` on a remote host, no client config) before it registers anything, then registers the host with `PUT /hosts/<name>` (with `rotate`, so it gets a token) using the client config (`--coord-url` and `--host-token` skip that), picks the `claude` path and PATH from the host's login shell (bash or zsh, plus `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin` when they exist), writes `~/.config/wd/git-token` from `gh auth token` when the host has no `--git-token-file` and gh is logged in, writes `agent.json` (listen on the Tailscale IPv4, else loopback for `local`), writes `~/.config/wd/client.json` on a remote host that has none (the coordinator url and caller token, no `caller`), and then waits for the host to be `ok`.
- `wd init-local <dir>` writes `coord.json` (with the host `local` listed in it), `agent.json` and `client.json` for a one-machine instance on `127.0.0.1`, and prints how to run `wd coord --config` and `wd agent --config` (backgrounded with `nohup`, or in two terminals).

## Configuration
**Coordinator:** `~/.config/wd/coord.json`, the path in `WD_CONFIG`, or `wd coord --config <file>`. Only `callerToken` is required.

| Key | Default | Meaning |
|---|---|---|
| `listen` | `127.0.0.1:7780` | address to bind |
| `db` | `~/.local/share/wd/wd.sqlite` | database file |
| `callerToken` | required | token for submitters |
| `hosts.<name>` | | `{url, token, labels?, maxThreads?}`; labels and `maxThreads` normally come from the agent. Optional: hosts can be registered through the API |
| `repos.<owner/name>` | | `{url, defaultRef, doctor?, requires?, rust?}`. Optional: repos can be registered through the API |
| `floors` | `{diskFreePct: 15, memReserveMb: 2048, cpuOversub: 1.5}` | placement floors; `cpuOversub` is how far past its cores a host may be committed |
| `tickMs`, `lostAfterSec`, `asleepLostSec`, `stallMin`, `runtimeMaxSec` | 5000, 120, 21600, 20, 14400 | timings |

**Agent:** `~/.config/wd/agent.json`, the path in `WD_AGENT_CONFIG`, or `wd agent --config <file>`.

| Key | Default | Meaning |
|---|---|---|
| `name`, `coordUrl`, `token` | required | must match the coordinator's `hosts` entry |
| `listen` | `0.0.0.0:7781` | `host install` binds it to the host's Tailscale address |
| `claude` | `claude` | path to the CLI |
| `labels` | `[]` | labels threads can require, besides the host's name |
| `maxThreads` | none | optional cap on concurrent turns; without it memory and CPU decide |
| `dataDir` | `~/.wd` | mirrors, worktrees, turns, target dirs |
| `gitTokenFile` | | GitHub token used for pushes |
| `path` | the login shell's PATH | PATH for doctors and turns |
| `targetDirPool` | 4 | Rust target dirs per repo |
| `autoUpdate` | true | update to the coordinator's release (see below) |

**Agent updates:** each heartbeat reply carries the coordinator's version. An agent on an older release downloads that release's binary for its platform from GitHub (`WD_RELEASES` overrides the base URL), checks it prints the version, renames it over its own binary and exits; systemd or launchd starts the new one, and running turns carry on. It waits while a worktree is being prepared, and a failed download is retried 10 minutes later. Agents run from source, and agents with `"autoUpdate": false`, never update. So deploying a release is `wd coord install`; the hosts follow within a heartbeat.

**Client:** `~/.config/wd/client.json` `{url, token, caller}` (or the file named by `WD_CLIENT_CONFIG`), or `WD_URL`, `WD_TOKEN` and `WD_CALLER`, which win over the file. With no caller set, it is `<hostname>:<cwd name>`. The installers do not write a `caller`.
