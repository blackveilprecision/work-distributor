// `wd <command>`: the CLI (a thin client of the coordinator's caller API), the installers and the daemons, as citty commands
// so that `wd <command> --help` explains each one.
import { defineCommand, renderUsage, runCommand, type ArgsDef, type CommandDef } from "citty";
import { ack, call, loadCfg, qs, reportText, type Cfg } from "./client.ts";
import { type Effort, EFFORTS, type HostView, type QueueView, type Report, type Steps, type ThreadView } from "../shared/types.ts";
import { VERSION } from "../shared/version.ts";

const json = (v: unknown) => console.log(JSON.stringify(v));
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`; };
const clock = (t: number) => (t ? new Date(t).toTimeString().slice(0, 8) : "--:--:--");
export const stepLines = (r: Steps) => r.steps.map((s) => `${clock(s.at)}  ${s.text}`);

// citty keeps only the last value of a repeated flag and has no way to ask for all of them (unjs/citty#258; the `multiple`
// modifier in #259 was not merged), so the flags that may be repeated are read from the raw arguments.
const many = (raw: string[], flag: string) =>
  raw.flatMap((a, i) => (a === `--${flag}` && raw[i + 1] !== undefined ? [raw[i + 1]] : a.startsWith(`--${flag}=`) ? [a.slice(flag.length + 3)] : []));
const num = (s: unknown) => (typeof s === "string" && s !== "" ? Number(s) : undefined);

const caller = {
  caller: { type: "string", valueHint: "name", description: "Inbox to use; default WD_CALLER, then client.json's caller, then <hostname>:<directory name>" },
} as const satisfies ArgsDef;
const cfgOf = (a: { caller?: string }): Cfg => { const c = loadCfg(); if (a.caller) c.caller = a.caller; return c; };
const thread = { id: { type: "positional", required: true, valueHint: "thread", description: "Thread id, as printed by submit or ls" } } as const satisfies ArgsDef;

// Follows the thread's latest turn until it ends; a follow-up turn that starts meanwhile is followed too.
async function tail(cfg: Cfg, id: string, v: { n?: string; turn?: string; follow?: boolean; json?: boolean }) {
  const get = (q: Record<string, string | number | undefined>): Promise<Steps> => call(cfg, "GET", `/threads/${id}/steps${qs(q)}`);
  let r = await get({ n: v.n ?? 20, turn: v.turn });
  if (v.json && !v.follow) return json(r);
  console.log(`-- ${id} turn ${r.turn}${r.running ? " (running)" : ""} --`);
  for (const l of stepLines(r)) console.log(l);
  while (v.follow && r.running) {
    await Bun.sleep(2000);
    const n = await get({ after: r.next, n: 500, turn: r.turn });
    for (const l of stepLines(n)) console.log(l);
    r = n;
    if (!r.running && !v.turn) {
      const latest = await get({ n: 1 });
      if (latest.turn !== r.turn) { r = await get({ turn: latest.turn, n: 500 }); console.log(`-- turn ${r.turn} --`); for (const l of stepLines(r)) console.log(l); }
    }
  }
  if (v.follow) console.log(`-- turn ${r.turn} ended --`);
}

export function queueText(q: QueueView): string {
  const out: string[] = [];
  if (q.holdUntil) out.push(`usage-limit hold until ${new Date(q.holdUntil).toISOString()}`);
  out.push(`queued (${q.queued.length})`);
  for (const t of q.queued) out.push(`  ${[t.id, t.repo, t.tag ?? "-", t.caller, ago(t.since), t.priority ? "priority" : "", t.waiting ?? "starting"].filter(Boolean).join("  ")}`);
  if (q.followUps.length) out.push(`follow-ups (${q.followUps.length})`);
  for (const t of q.followUps) out.push(`  ${[t.id, t.host ?? "-", t.tag ?? "-", `${t.count} send${t.count > 1 ? "s" : ""}`, ago(t.since), t.waiting ?? "starting"].join("  ")}`);
  if (q.idle?.length) out.push(`idle (${q.idle.length})`);
  for (const t of q.idle ?? []) out.push(`  ${[t.id, t.host ?? "-", t.tag ?? "-", `${t.turns} turn${t.turns === 1 ? "" : "s"}`, ago(t.since)].join("  ")}`);
  out.push("hosts");
  for (const h of q.hosts) {
    out.push(`  ${[h.name, h.state, runs(h), cpu(h), `mem=${h.memAvailMb}/${h.memTotalMb}MB`, `disk=${h.diskFreePct}%`, h.reason ?? ""].join("  ").trimEnd()}`);
    for (const t of h.threads) {
      out.push(`    ${[t.id, t.repo, t.tag ?? "-", t.caller, `turn ${t.turn}`, ago(t.startedAt)].join("  ")}`);
      if (t.activity) out.push(`      ${t.activity.at ? `${ago(t.activity.at)} ago` : "earlier"}: ${t.activity.text}`);
    }
  }
  return out.join("\n");
}

const runs = (h: HostView) => `${h.running}${h.maxThreads === null ? "" : `/${h.maxThreads}`}`;
// Load average plus CPU promised to running turns, of the host's cores; speed is the agent's single-core benchmark.
const cpu = (h: HostView) => `cpu=${(h.load1 + h.cpuPromisedCores).toFixed(1)}/${h.cores}${h.cpuScore ? ` speed=${h.cpuScore}` : ""}`;

// The hook must never block the user's prompt: any failure prints nothing and exits 0.
async function hook(cfg: Cfg, event: string, after?: string): Promise<void> {
  try {
    const reports: Report[] = await call(cfg, "GET", `/reports${qs({ caller: cfg.caller, after })}`, undefined, 3000, 0);
    if (!reports?.length) return;
    const ctx = `wd reports for ${cfg.caller} (already acknowledged; no wd_ack needed):\n\n` + reports.map(reportText).join("\n\n");
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: ctx } }));
    await Promise.all(reports.map((r) => ack(cfg, r.id, 3000, 0).catch(() => {})));
  } catch {}
}

// Blocks until the caller has an unacknowledged report. Polling rides out coordinator restarts; nothing is acked,
// so a watcher that is killed and restarted never loses a report.
export async function waitReports(cfg: Cfg, after?: string, everyMs = 2000): Promise<Report[]> {
  for (;;) {
    try {
      const r: Report[] = await call(cfg, "GET", `/reports${qs({ caller: cfg.caller, after })}`, undefined, 5000);
      if (r?.length) return r;
    } catch (e) {
      if (/: 40[0-4] /.test((e as Error).message)) throw e;
    }
    await Bun.sleep(everyMs);
  }
}

// ---- threads ----

const submit = defineCommand({
  meta: { name: "submit", description: "Queue a new thread: a Claude Code session on <repo> that runs <prompt> on a host with room. Prints {id, position}; the report arrives when the turn ends." },
  args: {
    repo: { type: "positional", required: true, valueHint: "owner/name", description: "A registered repo id (see `wd repo ls`)" },
    prompt: { type: "positional", required: true, valueHint: "prompt...", description: "The task; several words are joined. `-` reads it from stdin" },
    ref: { type: "string", valueHint: "ref", description: "Base ref for the work branch (default: the repo's default branch)" },
    branch: { type: "string", valueHint: "name", description: "Work branch to create and push (default: wd/<thread id>)" },
    model: { type: "string", valueHint: "model", description: "Passed to the runner's --model, e.g. sonnet, opus, haiku (claude) or deepseek/deepseek-flash (pi)" },
    effort: { type: "enum", options: [...EFFORTS], description: "Reasoning effort: claude --effort, pi --thinking (default: the host's settings for the model)" },
    runner: { type: "enum", options: ["claude", "pi"], description: "Which agent runs the thread (default: claude); pi models are provider/id[:thinking]" },
    billing: { type: "enum", options: ["api", "session"], description: "Who pays: session (default) drops API keys and bills the runner's stored subscription login; api uses the agent envFile's keys" },
    require: { type: "string", valueHint: "label", description: "Host label the thread needs; repeat for several" },
    size: { type: "enum", options: ["small", "heavy"], description: "Memory hint: small (2 GB) or heavy (8 GB); a floor under the repo's measured estimate" },
    priority: { type: "boolean", description: "Place before threads without it" },
    ttl: { type: "string", valueHint: "hours", description: "Keep the worktree this long after the last turn for follow-ups (default 24)" },
    tag: { type: "string", valueHint: "text", description: "Your own label, echoed in every report" },
    ...caller,
  },
  async run({ args, rawArgs }) {
    const words = args._.slice(1).join(" "), prompt = words === "-" ? await Bun.stdin.text() : words;
    if (!prompt.trim()) throw new Error("submit needs a prompt");
    const cfg = cfgOf(args), requires = many(rawArgs, "require");
    json(await call(cfg, "POST", "/threads", {
      caller: cfg.caller, repo: args.repo, prompt, ref: args.ref, model: args.model, effort: args.effort as Effort | undefined, runner: args.runner, billing: args.billing, requires: requires.length ? requires : undefined, size: args.size,
      priority: args.priority || undefined, ttlHours: num(args.ttl), tag: args.tag, branch: args.branch,
    }));
  },
});

const ls = defineCommand({
  meta: { name: "ls", description: "List this caller's threads (newest first): id, state, host, repo, branch, tag, reason." },
  args: { all: { type: "boolean", description: "Every caller's threads, not only this one's" }, ...caller },
  async run({ args }) {
    const cfg = cfgOf(args);
    for (const t of (await call(cfg, "GET", `/threads${qs({ caller: args.all ? undefined : cfg.caller })}`)) as ThreadView[])
      console.log([t.id, t.state, t.host ?? "-", t.repo, t.branch, t.tag ?? "", t.reason ?? ""].join("\t"));
  },
});

const status = defineCommand({
  meta: { name: "status", description: "Print one thread as JSON. Its lastMessage, like a report's message, is cut at 4,000 characters." },
  args: { ...thread, full: { type: "boolean", description: "Uncut lastMessage, plus every turn's whole text in messages" }, ...caller },
  async run({ args }) { json(await call(cfgOf(args), "GET", `/threads/${args.id}${args.full ? "?full=1" : ""}`)); },
});

const send = defineCommand({
  meta: { name: "send", description: "Queue a follow-up turn on a running or idle thread. It resumes the same session in the same worktree on the same host, after the current turn ends. Prints {queued: n}." },
  args: { ...thread, text: { type: "positional", required: true, valueHint: "text...", description: "The follow-up; several words are joined" }, ...caller },
  async run({ args }) { json(await call(cfgOf(args), "POST", `/threads/${args.id}/send`, { text: args._.slice(1).join(" ") })); },
});

const cancel = defineCommand({
  meta: { name: "cancel", description: "Stop a queued or running thread. It ends as cancelled, with a final report." },
  args: { ...thread, ...caller },
  async run({ args }) { json(await call(cfgOf(args), "POST", `/threads/${args.id}/cancel`)); },
});

const release = defineCommand({
  meta: { name: "release", description: "Finish an idle thread: remove its worktree (the pushed branch stays). No report is written, since you asked for it." },
  args: { ...thread, ...caller },
  async run({ args }) { json(await call(cfgOf(args), "POST", `/threads/${args.id}/release`)); },
});

const tailCmd = defineCommand({
  meta: { name: "tail", description: "What a turn is doing: its recent steps (tool calls by their main input, text claude wrote, ↳ results), with times." },
  args: {
    ...thread,
    n: { type: "string", alias: "n", valueHint: "count", description: "How many recent steps (default 20)" },
    turn: { type: "string", valueHint: "n", description: "A specific turn (default: the latest)" },
    follow: { type: "boolean", alias: "f", description: "Keep printing new steps until the turn ends, then follow a follow-up turn if one starts" },
    json: { type: "boolean", description: "Print the steps as JSON" },
    ...caller,
  },
  async run({ args }) { await tail(cfgOf(args), args.id, args); },
});

// ---- reports ----

const reports = defineCommand({
  meta: { name: "reports", description: "Print this caller's unacknowledged reports as JSON. Reports stay until acknowledged with `wd ack`." },
  args: {
    pending: { type: "boolean", description: "Accepted for compatibility; only pending reports are ever listed" },
    after: { type: "string", valueHint: "id", description: "Only reports with an id above this" },
    wait: { type: "boolean", description: "Block until there is at least one, print them and exit 0 (retries while the coordinator is down; exits 1 on a bad token)" },
    hook: { type: "boolean", description: "Claude Code hook mode: print the reports as hook context, acknowledge them, and never fail" },
    event: { type: "string", valueHint: "name", description: "Hook event name for --hook: SessionStart or UserPromptSubmit (default)" },
    ...caller,
  },
  async run({ args }) {
    const cfg = cfgOf(args);
    if (args.hook) return hook(cfg, args.event ?? "UserPromptSubmit", args.after);
    json(args.wait ? await waitReports(cfg, args.after) : await call(cfg, "GET", `/reports${qs({ caller: cfg.caller, after: args.after })}`));
  },
});

const ackCmd = defineCommand({
  meta: { name: "ack", description: "Acknowledge reports, so they are no longer pending. Prints nothing." },
  args: { ids: { type: "positional", required: true, valueHint: "report id...", description: "One or more report ids" }, ...caller },
  async run({ args }) { const cfg = cfgOf(args); for (const id of args._) await ack(cfg, Number(id)); },
});

// ---- the fleet ----

const hosts = defineCommand({
  meta: { name: "hosts", description: "Every host: state, running/max threads, available/total memory, free disk, why it is refused, and the repos whose doctor fails there." },
  args: { repo: { type: "string", valueHint: "owner/name", description: "Also say per host why a new thread of this repo would not start there now, or eligible" }, ...caller },
  async run({ args }) {
    for (const h of (await call(cfgOf(args), "GET", `/hosts${args.repo ? qs({ repo: args.repo }) : ""}`)) as HostView[])
      console.log([h.name, h.state, `run=${runs(h)}`, cpu(h), `mem=${h.memAvailMb}/${h.memTotalMb}MB`, `disk=${h.diskFreePct}%`,
        ...(args.repo ? [h.why ? `${args.repo}: ${h.why}` : `${args.repo}: eligible`] : []),
        h.reason ?? "", h.doctorFailed?.length ? `doctor fails: ${h.doctorFailed.join(",")}` : ""].filter(Boolean).join("\t"));
  },
});

const queue = defineCommand({
  meta: { name: "queue", description: "The whole queue across callers: queued threads in placement order and why each waits, pending follow-ups, idle threads, and each host's running threads with their latest step." },
  args: { json: { type: "boolean", description: "Print GET /queue as JSON (what the Herdr panel reads)" }, ...caller },
  async run({ args }) {
    const q: QueueView = await call(cfgOf(args), "GET", "/queue");
    if (args.json) json(q); else console.log(queueText(q));
  },
});

const hold = defineCommand({
  meta: { name: "hold", description: "Show the usage-limit hold: after Claude rejects a turn for the usage limit, no new turn starts until the reset time it gave." },
  args: { clear: { type: "boolean", description: "End the hold now, for a limit that was reset early (DELETE /hold)" }, ...caller },
  async run({ args }) {
    if (args.clear) return json(await call(cfgOf(args), "DELETE", "/hold"));
    const h = ((await call(cfgOf(args), "GET", "/queue")) as QueueView).holdUntil;
    console.log(h ? `new starts held until ${new Date(h).toISOString()} (wd hold --clear ends it)` : "no hold");
  },
});

const repoId = { id: { type: "positional", required: true, valueHint: "owner/name", description: "Repo id; without --url it means https://github.com/<id>.git" } } as const satisfies ArgsDef;
const repo = defineCommand({
  meta: { name: "repo", description: "Register, list and remove the repos threads may run on." },
  subCommands: {
    add: defineCommand({
      meta: { name: "add", description: "Register a repo (or replace its registration). Repos in coord.json win and are not changed." },
      args: {
        ...repoId,
        url: { type: "string", valueHint: "url", description: "Clone URL (default https://github.com/<id>.git); file:// works for a local repo" },
        ref: { type: "string", valueHint: "branch", description: "Default base branch (default main)" },
        doctor: { type: "string", valueHint: "command", description: "Shell command a host must pass in a checkout before it gets this repo's threads, e.g. \"bun --version\"" },
        require: { type: "string", valueHint: "label", description: "Host label every thread of this repo needs; repeat for several" },
        ...caller,
      },
      async run({ args, rawArgs }) {
        const requires = many(rawArgs, "require");
        const r = await call(cfgOf(args), "PUT", `/repos/${encodeURIComponent(args.id)}`, {
          url: args.url ?? `https://github.com/${args.id}.git`, defaultRef: args.ref, doctor: args.doctor, requires: requires.length ? requires : undefined });
        json(r);
        if (r.source === "config") console.error(`wd: ${args.id} is defined in coord.json, which wins: nothing was changed`);
      },
    }),
    ls: defineCommand({
      meta: { name: "ls", description: "List registered repos: id, url, default ref, doctor, required labels, source (db or config)." },
      args: { ...caller },
      async run({ args }) {
        for (const r of (await call(cfgOf(args), "GET", "/repos")) as any[])
          console.log([r.id, r.url, r.defaultRef, r.doctor ?? "", r.requires.join(","), r.source].join("\t"));
      },
    }),
    rm: defineCommand({
      meta: { name: "rm", description: "Remove a registered repo. Its queued or idle threads fail with \"no longer configured\"." },
      args: { ...repoId, ...caller },
      async run({ args }) { json(await call(cfgOf(args), "DELETE", `/repos/${encodeURIComponent(args.id)}`)); },
    }),
  },
});

// Whether rawArgs name one of cmd's subcommands (the first word that is not a flag or a flag's value).
const sub = (rawArgs: string[], cmd: CommandDef<any>) => {
  const w = rawArgs.find((a, i) => !a.startsWith("-") && !(i > 0 && rawArgs[i - 1] === "--config"));
  return !!w && Object.hasOwn((cmd.subCommands ?? {}) as object, w);
};

const target = { target: { type: "positional", required: true, valueHint: "ssh-host|local", description: "Anything ssh accepts, or `local` for this machine (no ssh)" } } as const satisfies ArgsDef;
const config = { config: { type: "string", valueHint: "file", description: "Config file (default ~/.config/wd/coord.json or agent.json)" } } as const satisfies ArgsDef;

const coord = defineCommand({
  meta: { name: "coord", description: "Run the coordinator (the queue, placement and reports; it listens on coord.json's `listen`), or install it as a service with `wd coord install`." },
  args: { ...config },
  subCommands: {
    install: defineCommand({
      meta: { name: "install", description: "Install the coordinator on a machine: copy or build the binary into ~/.local/bin, write coord.json with a random caller token unless one exists, start the wd-coord service (systemd user unit, or LaunchAgent on macOS), and write this machine's client.json unless one exists." },
      args: { ...target, listen: { type: "string", valueHint: "ip:port", description: "Address to listen on (default: the machine's Tailscale IPv4, else 127.0.0.1, port 7780)" } },
      async run({ args }) { await (await import("./install.ts")).coordInstall(args.target, { listen: args.listen }); },
    }),
  },
  async run({ rawArgs }) {
    if (sub(rawArgs, coord)) return;   // citty runs a command's own run after its subcommand too
    await (await import("../coord/main.ts")).coordMain(rawArgs);
  },
});

const host = defineCommand({
  meta: { name: "host", description: "Install agents on the machines that run threads." },
  subCommands: {
    install: defineCommand({
      meta: { name: "install", description: "Install an agent: register the host with the coordinator in client.json, copy or build the binary, write agent.json (kept if it exists), copy gh's token for pushes, write client.json there if missing, start the wd-agent service, and wait for the host to be ok." },
      args: {
        ...target,
        name: { type: "string", valueHint: "name", description: "Host name (default: the ssh host, or this machine's hostname for local)" },
        label: { type: "string", valueHint: "label", description: "Label threads can require; repeat for several (default: the OS)" },
        claude: { type: "string", valueHint: "path", description: "claude on the host (default: found on its login PATH)" },
        "agent-url": { type: "string", valueHint: "url", description: "URL the coordinator reaches the agent at (default http://<tailscale ip>:7781)" },
        "git-token-file": { type: "string", valueHint: "path", description: "GitHub token file on the host for pushes (default: written from gh auth token)" },
        "coord-url": { type: "string", valueHint: "url", description: "Coordinator URL; with --host-token, skips registering" },
        "host-token": { type: "string", valueHint: "token", description: "Host token for a host defined in coord.json" },
      },
      async run({ args, rawArgs }) {
        const labels = many(rawArgs, "label");
        await (await import("./install.ts")).hostInstall({
          host: args.target, name: args.name, coordUrl: args["coord-url"], hostToken: args["host-token"], gitTokenFile: args["git-token-file"],
          labels: labels.length ? labels : undefined, claude: args.claude, agentUrl: args["agent-url"] });
      },
    }),
  },
});

const agent = defineCommand({
  meta: { name: "agent", description: "Run the agent on this host: repo mirrors, worktrees, turns, pushes. Started by the wd-agent service that `wd host install` sets up." },
  args: { ...config },
  subCommands: {
    probe: defineCommand({
      meta: { name: "probe", description: "Print what the agent's probe sees (OS, memory, disk, claude, login) and exit 1 when it would refuse the host." },
      args: { ...config },
      async run({ rawArgs }) { return (await import("../agent/main.ts")).agentMain(["probe", ...rawArgs]); },
    }),
  },
  async run({ rawArgs }) {
    if (sub(rawArgs, agent)) return;
    return (await import("../agent/main.ts")).agentMain(rawArgs);
  },
});

const mcp = defineCommand({
  meta: { name: "mcp", description: "Run the MCP server on stdio: the wd_* tools and the report channel for a Claude Code session. The plugin starts it." },
  async run({ rawArgs }) { await (await import("../mcp/server.ts")).mcpMain(rawArgs); },
});

const initLocal = defineCommand({
  meta: { name: "init-local", description: "Write coord.json, agent.json and client.json for a one-machine trial on 127.0.0.1 into <dir>, and print how to start it. Touches nothing in ~/.config/wd." },
  args: {
    dir: { type: "positional", required: true, valueHint: "dir", description: "An empty directory for the trial's config and data" },
    "port-base": { type: "string", valueHint: "port", description: "Ports to use: this one and the next (default 17780)" },
  },
  async run({ args }) { (await import("./install.ts")).initLocal(args.dir, num(args["port-base"])); },
});

export const main = defineCommand({
  meta: {
    name: "wd", version: VERSION,
    description: "Queue Claude Code threads, run them on your hosts, and get reports back. The coordinator's address and token come from WD_URL and WD_TOKEN, or ~/.config/wd/client.json (WD_CLIENT_CONFIG names another file).",
  },
  subCommands: {
    submit, ls, status, send, cancel, release, tail: tailCmd, reports, ack: ackCmd, queue, hold, hosts, repo,
    coord, host, agent, mcp, "init-local": initLocal,
  },
});

// The usage of the command a word list names (`wd repo add --help`), with its whole path in the usage line. citty colours
// it whenever NO_COLOR is unset, so the colours are dropped when it does not go to a terminal.
async function usage(argv: string[], tty = !!process.stdout.isTTY): Promise<string> {
  let cmd: CommandDef<any> = main;
  const path = ["wd"];
  for (const w of argv.filter((a) => !a.startsWith("-"))) {
    const subs = (cmd.subCommands ?? {}) as Record<string, CommandDef<any>>;
    if (!Object.hasOwn(subs, w)) break;
    cmd = subs[w];
    path.push(w);
  }
  const text = await renderUsage(cmd, path.length > 1 ? { meta: { name: path.slice(0, -1).join(" "), version: VERSION } } : undefined);
  return plain(text, tty);
}
// citty accepts any flag, so a mistyped one (--requre) would be silently ignored: the first flag the command does not
// define, or null. Words after `--` are left alone.
function unknownFlag(argv: string[]): string | null {
  let cmd: CommandDef<any> = main;
  for (const w of argv.filter((a) => !a.startsWith("-"))) {
    const subs = (cmd.subCommands ?? {}) as Record<string, CommandDef<any>>;
    if (!Object.hasOwn(subs, w)) break;
    cmd = subs[w];
  }
  const known = new Set(["help", "h"]);
  for (const [name, def] of Object.entries((cmd.args ?? {}) as ArgsDef)) {
    known.add(name);
    for (const a of [(def as any).alias ?? []].flat()) known.add(a);
  }
  for (const a of argv) {
    if (a === "--") break;
    if (!a.startsWith("-") || a === "-") continue;
    const name = a.replace(/^--?/, "").split("=")[0];
    if (!known.has(name) && !known.has(name.replace(/^no-/, ""))) return a;
  }
  return null;
}

const plain = (s: string, tty = !!process.stdout.isTTY) => (tty ? s : s.replace(/\x1b\[[0-9;]*m/g, ""));

export async function cliMain(argv: string[]): Promise<number> {
  const isHook = argv.includes("--hook");
  if (!argv.length || argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
    console.log(await usage(argv[0] === "help" ? argv.slice(1) : argv));
    return 0;
  }
  const bad = unknownFlag(argv);
  if (bad) {
    if (isHook) return 0;
    console.error(`${await usage(argv, !!process.stderr.isTTY)}\n\nwd: unknown option ${bad}`);
    return 2;
  }
  try {
    const code = (await runCommand(main, { rawArgs: argv })).result;   // only the agent returns one
    return typeof code === "number" ? code : 0;
  } catch (e) {
    if (isHook) return 0;
    if ((e as Error).name === "CLIError") {   // a usage mistake: unknown command, missing argument
      console.error(`${await usage(argv, !!process.stderr.isTTY)}\n\nwd: ${plain((e as Error).message, !!process.stderr.isTTY)}`);
      return 2;
    }
    console.error(`wd: ${(e as Error).message}`);
    return 1;
  }
}
