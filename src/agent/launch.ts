// One turn: the run file, the start, how it is doing, how it ended, how it is stopped.
// Linux: a transient systemd user unit (ported from builder/lib/launch.mjs, which is proven). darwin: a detached
// process group, because macOS has no cgroups and a process started over ssh cannot reach the keychain anyway.
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import type { StartTurn, TurnEnd } from "../shared/types";
import { type AgentConfig, run, sleep } from "./config";

export interface TurnMeta {
  s: StartTurn; key: string; dir: string; wt: string; mode: "systemd" | "pgroup";
  pid: number | null; unit: string | null; startedAt: number; target: string | null;
}
export interface Status { running: boolean; cpuMs: number; memMb: number }

export const turnKey = (s: { thread: string; epoch: number; turn: number }) => `${s.thread}-${s.epoch}-${s.turn}`;
export const turnDir = (cfg: AgentConfig, key: string) => join(cfg.dataDir, "turns", key);
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim() : null);

// What the session may see. No GH_TOKEN, GITHUB_TOKEN or SSH_AUTH_SOCK in its environment, and the agent does the
// pushing. That is hygiene, not isolation: the worker runs as the same user, so it can still read whatever that user can
// (gitTokenFile, the host token in ~/.config/wd/agent.json, ~/.ssh). Real isolation needs a separate user for the worker.
export function turnEnv(s: StartTurn, wt: string, o: { target?: string | null; sccache?: string | null; path?: string } = {}): Record<string, string> {
  const home = process.env.HOME ?? userInfo().homedir, user = process.env.USER ?? userInfo().username;
  return {
    HOME: home, USER: user, LOGNAME: process.env.LOGNAME ?? user,
    PATH: o.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    SHELL: "/bin/bash", TMPDIR: join(wt, ".wd-tmp"), WD_THREAD: s.thread, WD_KEY: `${s.thread}-${s.epoch}`,
    DISABLE_AUTOUPDATER: "1",
    ...(o.target ? { CARGO_TARGET_DIR: o.target } : {}), ...(o.sccache ? { RUSTC_WRAPPER: o.sccache } : {}),
  };
}

export function claudeArgs(s: StartTurn): string[] {
  return [
    "-p", "--output-format", "stream-json", "--verbose",
    ...(s.resume ? ["--resume", s.sessionId] : ["--session-id", s.sessionId]),
    "--setting-sources", "user", "--strict-mcp-config",
    "--settings", JSON.stringify({ crossSessionInbound: "refuse", syncClaudeAiPlugins: false, syncClaudeAiSkills: false }),
    "--dangerously-skip-permissions", ...(s.model ? ["--model", s.model] : []),
  ];
}

// Every word is quoted here and the file is started by path, because systemd rewrites ${NAME} and $$ in a unit's own
// arguments. The lock dir makes a second start of the same turn leave at once. The exit file is the only record of
// claude's own exit code, written last and atomically.
export function runScript(dir: string, claude: string, args: string[], env: Record<string, string>): string {
  const envWords = Object.entries(env).map(([k, v]) => quote(`${k}=${v}`)).join(" ");
  return [
    `JOB=${quote(dir)}`,
    `mkdir "$JOB/lock" 2>/dev/null || exit 0`,
    `echo $$ > "$JOB/pid"`,
    `env -i ${envWords} ${[claude, ...args].map(quote).join(" ")} < "$JOB/prompt.txt" > "$JOB/out.jsonl" 2> "$JOB/err.log"`,
    `echo $? > "$JOB/exit.tmp"; mv "$JOB/exit.tmp" "$JOB/exit"`,
  ].join("\n") + "\n";
}

// Fixed words and paths only. Never --collect: the plain unit plus the exit file keeps every ending readable.
export function systemdRunArgs(o: { unit: string; dir: string; cwd: string; memoryMb: number; seconds: number }): string[] {
  return [
    "--user", "--quiet", `--unit=${o.unit}`, "-p", `MemoryMax=${o.memoryMb}M`, "-p", `RuntimeMaxSec=${o.seconds || "infinity"}`,
    "-p", "TimeoutStopSec=10", `--working-directory=${o.cwd}`, "/bin/bash", join(o.dir, "run.sh"),
  ];
}

export async function launch(cfg: AgentConfig, s: StartTurn, wt: string, target: string | null): Promise<TurnMeta> {
  const key = turnKey(s), dir = turnDir(cfg, key);
  mkdirSync(dir, { recursive: true });
  const sccache = target ? Bun.which("sccache", { PATH: cfg.path }) : null;
  const mode = process.platform === "linux" ? "systemd" : "pgroup";
  const meta: TurnMeta = { s, key, dir, wt, mode, pid: null, unit: mode === "systemd" ? `wd-${key}` : null, startedAt: Date.now(), target };
  writeFileSync(join(dir, "prompt.txt"), s.prompt);
  writeFileSync(join(dir, "run.sh"), runScript(dir, cfg.claude, claudeArgs(s), turnEnv(s, wt, { target, sccache, path: cfg.path })));
  if (mode === "systemd") {
    if (/[$%]/.test(dir + wt)) throw new Error(`a path with "$" or "%" cannot go on a systemd-run line: ${dir} ${wt}`);
    const r = await run(["systemd-run", ...systemdRunArgs({ unit: meta.unit!, dir, cwd: wt, memoryMb: s.memoryMaxMb, seconds: s.runtimeMaxSec })]);
    if (!r.ok) throw new Error(`systemd-run failed: ${r.err}`);
  } else {
    const p = Bun.spawn(["/bin/bash", join(dir, "run.sh")], { cwd: wt, detached: true, stdio: ["ignore", "ignore", "ignore"] });
    p.unref();
    meta.pid = p.pid;   // detached gives the child its own session, so pid == pgid
  }
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  return meta;
}

// ---- darwin: the process tree ----

export function cpuMsOf(t: string): number {
  const [d, rest] = t.includes("-") ? t.split("-") : ["0", t];
  return Math.round((Number(d) * 86400 + rest.split(":").reduce((s, p) => s * 60 + Number(p), 0)) * 1000);
}
export interface Proc { pid: number; ppid: number; pgid: number; rssKb: number; stat: string; cpuMs: number; cmd: string }
export function parsePs(text: string): Proc[] {
  const rows: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], rssKb: +m[4], stat: m[5], cpuMs: cpuMsOf(m[6]), cmd: m[7] });
  }
  return rows;
}
// ps cannot show another process's environment on macOS, so the marker is the turn dir in the command line (run.sh)
// plus the group. After run.sh (the only process with the dir in its command line, since env -i execs claude) is gone,
// its pgid still names the survivors, and a pgid cannot be reused while the group has members. So the group is ours
// unless a process with that very pid exists and is not our run.sh: only then was the pid handed to something else.
// The descendants of those count too: Claude Code runs each Bash command in a process group of its own, so the group
// alone held only claude, never the builds and tests a turn runs. A process that outlives its parent is reparented
// to launchd and drops out (a daemon such as sccache's server, which serves every turn anyway).
async function groupProcs(meta: TurnMeta): Promise<{ rows: Proc[]; ours: boolean }> {
  const r = await run(["ps", "-axo", "pid=,ppid=,pgid=,rss=,stat=,time=,command="], { timeout: 15_000 });
  const rows = parsePs(r.out).filter((p) => !p.stat.startsWith("Z"));
  const lead = rows.find((p) => p.pid === meta.pid);
  const ours = meta.pid !== null && !(lead && !lead.cmd.includes(meta.dir));
  return { rows: treeOf(rows, (p) => p.cmd.includes(meta.dir) || (ours && p.pgid === meta.pid)), ours };
}

export function treeOf(rows: Proc[], root: (p: Proc) => boolean): Proc[] {
  const kids = new Map<number, Proc[]>();
  for (const p of rows) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const out = new Map<number, Proc>(), todo = rows.filter(root);
  for (let p; (p = todo.pop()); ) if (!out.has(p.pid)) { out.set(p.pid, p); todo.push(...(kids.get(p.pid) ?? [])); }
  return [...out.values()];
}

// CPU time of processes that exited is gone from ps, so the plain sum of what is alive goes down as well as up (a build
// of short compiler processes). The counter adds each pid's growth since it was last seen and never goes down.
const cpuSeen = new Map<string, { last: Map<number, number>; total: number }>();
// seed: the first call only records where each process is, so processes already running (an agent restart finds the
// hc terminals mid-build) do not count their whole past CPU as if it was spent in one heartbeat.
export function cpuCounter(key: string, rows: { pid: number; cpuMs: number }[], seed = false): number {
  if (seed && !cpuSeen.has(key)) { cpuSeen.set(key, { last: new Map(rows.map((p) => [p.pid, p.cpuMs])), total: 0 }); return 0; }
  const c = cpuSeen.get(key) ?? { last: new Map<number, number>(), total: 0 };
  cpuSeen.set(key, c);
  const now = new Map<number, number>();
  for (const p of rows) {
    const before = c.last.get(p.pid);
    c.total += before === undefined ? p.cpuMs : Math.max(0, p.cpuMs - before);
    now.set(p.pid, p.cpuMs);
  }
  c.last = now;
  return c.total;
}

// ---- linux: the unit, and what the turn started outside it ----

// A command a turn starts through `hc run` is started by the hc server, outside the turn's unit. It is found by its
// working directory, the turn's worktree, and counted with its descendants (a compiler runs in a crate's own folder).
// Only measured, never moved into the unit: the unit's end would kill work the thread left running on purpose.
export function outside(meta: Pick<TurnMeta, "key" | "wt" | "unit">, proc = "/proc"): { cpuMs: number; memMb: number } {
  const rows: Proc[] = [], roots = new Set<number>(), unit = `/${meta.unit}.service`;
  for (const d of readdirSync(proc)) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readFileSync(`${proc}/${d}/cgroup`, "utf8").split("\n").some((l) => l.endsWith(unit) || l.includes(`${unit}/`))) continue;   // the unit counts these
      const t = readFileSync(`${proc}/${d}/stat`, "utf8"), f = t.slice(t.lastIndexOf(")") + 2).split(" ");
      if (f[0] === "Z") continue;
      // utime and stime are in clock ticks, 100 a second on Linux; rss is in 4 KiB pages.
      rows.push({ pid: +d, ppid: +f[1], pgid: +f[2], rssKb: +f[21] * 4, stat: f[0], cpuMs: (+f[11] + +f[12]) * 10, cmd: "" });
      const cwd = readlinkSync(`${proc}/${d}/cwd`);
      if (cwd === meta.wt || cwd.startsWith(meta.wt + "/")) roots.add(+d);
    } catch {}   // gone meanwhile, or not ours to read
  }
  const tree = treeOf(rows, (p) => roots.has(p.pid));
  return { cpuMs: cpuCounter(`${meta.key}:outside`, tree, true), memMb: tree.reduce((n, p) => n + p.rssKb, 0) / 1024 };
}
// The tailer asks every second; reading all of /proc every 5 s is enough.
const outsideSeen = new Map<string, { at: number; v: { cpuMs: number; memMb: number } }>();
function outsideCached(meta: TurnMeta) {
  const c = outsideSeen.get(meta.key);
  if (c && Date.now() - c.at < 5000) return c.v;
  const v = process.platform === "linux" ? outside(meta) : { cpuMs: 0, memMb: 0 };
  outsideSeen.set(meta.key, { at: Date.now(), v });
  return v;
}

interface Unit { load: string; active: string; result: string; cpuMs: number; memMb: number }
async function showUnit(unit: string): Promise<Unit | null> {
  const r = await run(["systemctl", "--user", "show", unit, "-p", "LoadState,ActiveState,Result,CPUUsageNSec,MemoryPeak"], { timeout: 20_000 });
  if (!r.ok) return null;
  const f = Object.fromEntries(r.out.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const num = (v: string) => (/^\d+$/.test(v) ? Number(v) : 0);   // "[not set]" once the unit is gone
  return { load: f.LoadState, active: f.ActiveState, result: f.Result, cpuMs: num(f.CPUUsageNSec) / 1e6, memMb: num(f.MemoryPeak) / 1048576 };
}
const unitRunning = (u: Unit | null) => !!u && u.load === "loaded" && ["active", "activating", "deactivating", "reloading"].includes(u.active);

export async function status(meta: TurnMeta): Promise<Status> {
  if (meta.mode === "systemd") {
    const u = await showUnit(meta.unit!), o = outsideCached(meta);
    return { running: unitRunning(u), cpuMs: (u?.cpuMs ?? 0) + o.cpuMs, memMb: (u?.memMb ?? 0) + o.memMb };
  }
  const { rows } = await groupProcs(meta);
  return { running: rows.length > 0, cpuMs: cpuCounter(meta.key, rows, true), memMb: rows.reduce((s, p) => s + p.rssKb, 0) / 1024 };
}

// The reason file is written before any kill, so the ending is classified as ours and not as a crash.
export async function stopTurn(meta: TurnMeta, reason: "killed" | "timeout" | "stale"): Promise<void> {
  const file = join(meta.dir, "reason");
  if (!existsSync(file)) writeFileSync(file, reason);
  if (meta.mode === "systemd") {
    await run(["systemctl", "--user", "stop", meta.unit!], { timeout: 40_000 });
  } else {
    // The tree is read before anything dies: a descendant whose parent is gone is reparented and can no longer be found.
    const tree = (await groupProcs(meta)).rows;
    try { process.kill(-meta.pid!, "SIGTERM"); } catch {}
    for (const p of tree) try { process.kill(p.pid, "SIGTERM"); } catch {}
    for (let i = 0; i < 50 && (await groupProcs(meta)).rows.length; i++) await sleep(200);
    // Survivors from the first read (reparented ones are not in the tree any more), checked to be the same process.
    const now = parsePs((await run(["ps", "-axo", "pid=,ppid=,pgid=,rss=,stat=,time=,command="], { timeout: 15_000 })).out);
    for (const p of tree) if (now.some((q) => q.pid === p.pid && q.cmd === p.cmd)) try { process.kill(p.pid, "SIGKILL"); } catch {}
  }
  await sweep(meta);
}

// Whatever is still running for this turn after its main process is gone or stopped is killed.
export async function sweep(meta: TurnMeta): Promise<void> {
  if (meta.mode === "pgroup") {
    const { rows, ours } = await groupProcs(meta);
    if (ours) try { process.kill(-meta.pid!, "SIGKILL"); } catch {}   // ESRCH when nothing is left, which is the usual case
    for (const p of rows) try { process.kill(p.pid, "SIGKILL"); } catch {}
    return;
  }
  // Marked processes (WD_KEY in their environment) wherever they sit, and the run-* scopes that hold only ours.
  const key = `WD_KEY=${meta.s.thread}-${meta.s.epoch}`;
  const found = await run(["/bin/sh", "-c", 'exec grep -lazsx -e "$1" /proc/[0-9]*/environ', "sh", key], { timeout: 15_000 });
  const marked = found.out.split("\n").map((p) => p.split("/")[2]).filter(Boolean);
  const parentOf = (pid: string) => { try { const t = readFileSync(`/proc/${pid}/stat`, "utf8"); return t.slice(t.lastIndexOf(")") + 2).split(" ")[1]; } catch { return null; } };
  const ours = (pid: string) => { for (let p: string | null = pid, n = 0; p && p !== "0" && n < 64; p = parentOf(p), n++) if (marked.includes(p)) return true; return false; };
  const scopes = new Set<string>();
  for (const pid of marked) {
    try {
      const at = /^0::(\/.*\/(run-[^/\n]*\.scope))$/m.exec(readFileSync(`/proc/${pid}/cgroup`, "utf8"));
      if (at && readFileSync(`/sys/fs/cgroup${at[1]}/cgroup.procs`, "utf8").split("\n").filter(Boolean).every(ours)) scopes.add(at[2]);
    } catch {}
  }
  for (const pid of marked) try { process.kill(Number(pid), "SIGKILL"); } catch {}
  for (const sc of scopes) await run(["systemctl", "--user", "stop", sc]);
}

// How a turn that is no longer running ended. For a unit the Result wins over the exit file, because a memory kill can
// leave an exit file of 137 or none at all.
export function classify(u: { load: string; active: string; result: string } | null, exit: number | null, reason: string | null, mode: "systemd" | "pgroup"): { kind: TurnEnd["kind"]; exitCode: number | null } {
  if (reason) return { kind: reason === "timeout" ? "timeout" : "killed", exitCode: exit };
  if (u && u.load === "loaded" && u.active === "failed") return { kind: u.result === "timeout" ? "timeout" : u.result === "oom-kill" ? "oom" : "killed", exitCode: exit };
  if (exit === null) return { kind: "lost", exitCode: null };
  // Without cgroups a SIGKILL nobody sent from here is most likely the system under memory pressure.
  return { kind: mode === "pgroup" && exit === 137 ? "oom" : "exited", exitCode: exit };
}
export async function endOf(meta: TurnMeta): Promise<{ kind: TurnEnd["kind"]; exitCode: number | null }> {
  const e = read(join(meta.dir, "exit")), u = meta.mode === "systemd" ? await showUnit(meta.unit!) : null;
  const end = classify(u, e === null ? null : Number(e), read(join(meta.dir, "reason")), meta.mode);
  // A failed transient unit stays loaded until reset; now that its Result is read, let it go.
  if (u) await run(["systemctl", "--user", "reset-failed", meta.unit!], { timeout: 20_000 });
  return end;
}
export const readMeta = (dir: string): TurnMeta => JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
