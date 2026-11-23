# Working on wd

wd queues Claude Code threads, runs them on hosts and reports back.
- What it is and how to use it: [README.md](README.md).
- How it works inside: [docs/how-it-works.md](docs/how-it-works.md). Read it before changing behaviour.
- Contributing (setup, pull requests, security reports): [CONTRIBUTING.md](CONTRIBUTING.md).
- `contrib/herdr/`: an optional panel for the Herdr app that shows `wd queue`; not part of the binary.

`src/shared/types.ts` is the contract between the coordinator, the agent and the clients. Change it first, then the parts that use it.

## Commands
```sh
bun install
bun test                         # everything, including e2e (about 1 minute)
bun test test/coord              # one area; or one file: bun test test/agent/agent.test.ts
bunx tsc --noEmit
bun run build                    # dist/wd for this machine
bun run build:linux              # dist/wd-linux-x64
```
Before a change is done, run `bun test`, `bunx tsc --noEmit` and `bun run build`, and fix anything that fails.

## Rules
- **Scope:** wd runs threads and reports on them. Planning, PR handling, merging, review and retries belong to the caller. Don't add them.
- **Keep it small:** about 2,250 lines of non-test source in `src/` (`contrib/` is not counted). Write plain code with no frameworks, and add no npm dependencies beyond `@modelcontextprotocol/sdk` and `citty` (the CLI: every command in `src/cli/main.ts` is a citty command with a description and described args, which is what `wd <command> --help` prints).
- **The coordinator is the only writer to SQLite.** The agent keeps its state as files in its data dir.
- **Host tools:** the binary may rely only on `git`, `claude`, `systemd-run`/`systemctl` on Linux, `ps`/`kill` on macOS, and the user's bash or zsh, run once at start as an interactive login shell to read its PATH. No `flock`, `timeout`, GNU-only flags or `chmod --`, because macOS hosts don't have them. The installers run POSIX shell, `bash -l` (and the login shell with `-lic` to find `claude`), `curl` and, when present, `tailscale` and `gh` on the target; keep their commands to that.
- **Epochs:** every message between agent and coordinator carries the epoch, and stale ones are refused. Don't add a path that pushes or reports without it.
- **Workers:** worker sessions get a fixed environment with no GitHub credentials and no wd plugin. Only the agent pushes.
- **Tests:**
  - Never run a real `claude` and never call GitHub. Use `test/fake-claude.ts` and a local bare repo as origin.
  - The fake must keep the real CLI's output shape. Real `claude` writes `"type"` late in its `result` line, and its `duration_ms` leaves out tool time.
  - Tests run on macOS. The systemd path is covered by argument-building tests.
  - The installers (`src/cli/install.ts`) run through a `Target`; tests pass a recording fake, so nothing touches ssh, `launchctl`, `systemctl` or the real `~/.config/wd`. Client-side tests set `WD_CLIENT_CONFIG` or `HOME` to a temp location. `test/init-local.test.ts` starts a real coordinator and agent from `wd init-local` files on free ports.
- **Tests on a shared host:** never run broad `pkill` or `tmux kill-server` there. Scope kills to the test's own temp dir or socket.
- **Comments:** only where the why is not obvious.

## Releasing
1. Set `version` in `package.json` (it is what `wd --version` prints and what installers download), commit, and push to `main`.
2. On a Mac, run `scripts/release.sh`. It checks the tree, runs the checks, builds and signs the macOS binaries and publishes the GitHub release `v<version>` with them. Hosted macOS runners are too scarce to rely on, so this step is local.
3. Publishing starts `.github/workflows/release.yml` on Linux: it adds `wd-linux-{x64,arm64}` and `SHA256SUMS` to the release and commits `Formula/wd.rb` (from `scripts/formula.ts`) to `main`.

CI (`.github/workflows/ci.yml`) runs tsc, the build and the coordinator and client tests on Linux; the full suite is yours to run on macOS.

## Deploying a change
1. Build the binaries.
2. Copy them to `~/.local/bin/wd` on each host.
3. Restart:
   - Linux: `systemctl --user restart wd-agent`, plus `wd-coord` on the coordinator host;
   - macOS: `launchctl kickstart -k gui/$(id -u)/wd.agent`.

`wd host install <host|local>` (and `wd coord install` for the coordinator) does the build, copy and restart, and leaves an existing `agent.json` or `coord.json` alone. Hosts and repos are normally registered at runtime (`wd repo add`, `PUT /hosts/<name>`) and kept in the coordinator's database; `coord.json` entries still work and win.

Running turns survive an agent restart.
