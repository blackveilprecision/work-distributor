// What the host looks like right now, and whether it can run a session at all. Anything in `problems` refuses the host.
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem, userInfo } from "node:os";
import { join } from "node:path";
import type { Probe } from "../shared/types";
import { type AgentConfig, run } from "./config";

interface Login { at: number; ok: boolean; error: string | null; expires: number | null; claude: string }
let login: Login | null = null, gen = 0;
// A check still running when the cache is reset must not store its (now stale) result afterwards, and a result is
// only reused for the claude it checked (several agents share this module in tests).
export const resetLoginCache = () => { login = null; gen++; };

// The login check costs a real (tiny) model call, so a good result is kept for an hour. A bad one is rechecked
// after two minutes, so a fixed login is noticed without hammering.
export async function loginCheck(cfg: AgentConfig): Promise<Login> {
  if (login && login.claude === cfg.claude && Date.now() - login.at < (login.ok ? 3_600_000 : 120_000)) return login;
  const user = process.env.USER ?? userInfo().username, mine = gen;
  // The same fixed environment a turn gets (env -i): a login that only works from the agent's own env is no login.
  const r = await run([cfg.claude, "-p", "ok", "--model", "haiku", "--output-format", "json", "--max-turns", "1"], {
    cwd: cfg.dataDir, timeout: 120_000,
    env: { HOME: process.env.HOME ?? userInfo().homedir, USER: user, LOGNAME: user, PATH: process.env.PATH },
  });
  let res: any = null;
  try { const j = JSON.parse(r.out); res = Array.isArray(j) ? j.findLast((e) => e?.type === "result") : j; } catch {}
  let error: string | null = null;
  if (!res) error = `claude -p gave no result (exit ${r.code}): ${(r.err || r.out).slice(0, 300)}`;
  else if (res.is_error || /not logged in/i.test(String(res.result))) error = String(res.result ?? "is_error").slice(0, 300);
  const exp = Number(res?.credential_expires_at) || null;
  const l = { at: Date.now(), ok: !error, error, expires: exp && exp < 1e12 ? exp * 1000 : exp, claude: cfg.claude };
  if (mine === gen) login = l;
  return l;
}

async function memAvailMb(): Promise<number> {
  if (process.platform === "linux") {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    if (m) return Math.round(Number(m[1]) / 1024);
  } else {
    // free + inactive + speculative pages are what the OS hands out without swapping
    const v = (await run(["/usr/bin/vm_stat"], { timeout: 10_000 })).out;
    const page = Number(/page size of (\d+) bytes/.exec(v)?.[1] ?? 16384);
    const pages = ["Pages free", "Pages inactive", "Pages speculative"].reduce((s, k) => s + Number(new RegExp(`${k}:\\s+(\\d+)`).exec(v)?.[1] ?? 0), 0);
    if (pages) return Math.round((pages * page) / 1048576);
  }
  return Math.round(freemem() / 1048576);
}

export async function probe(cfg: AgentConfig): Promise<Probe> {
  mkdirSync(cfg.dataDir, { recursive: true });
  const fs = statfsSync(cfg.dataDir);
  const os = process.platform === "linux" ? "linux" : "darwin";
  const problems: string[] = [];
  const v = await run([cfg.claude, "--version"], { timeout: 20_000 });
  const claudeVersion = v.ok ? v.out.split(/\s+/)[0] || null : null;
  if (!claudeVersion) problems.push(`claude not runnable (${cfg.claude}): ${v.err.slice(0, 200)}`);
  const lg = claudeVersion ? await loginCheck(cfg) : null;
  if (lg && !lg.ok) problems.push(`claude login: ${lg.error}`);
  const diskFreePct = Math.round((fs.bavail / fs.blocks) * 1000) / 10;
  if (diskFreePct < 5) problems.push(`disk almost full (${diskFreePct}% free)`);
  if (fs.files > 0 && fs.ffree / fs.files < 0.05) problems.push("inodes almost exhausted");
  if (os === "linux") {
    const user = process.env.USER ?? userInfo().username;
    const l = await run(["loginctl", "show-user", user, "-p", "Linger"], { timeout: 10_000 });
    if (!/Linger=yes/.test(l.out)) problems.push("systemd linger is off (loginctl enable-linger), the agent would stop at logout");
    if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) problems.push("cgroup v2 not available");
  }
  return {
    os, cores: cpus().length, memTotalMb: Math.round(totalmem() / 1048576), memAvailMb: await memAvailMb(),
    load1: Math.round(loadavg()[0] * 100) / 100, cpuScore: speed(join(cfg.dataDir, "speed")),
    diskFreePct, diskFreeGb: Math.round((fs.bavail * fs.bsize) / 1e9), claudeVersion,
    loginOk: !!lg?.ok, loginError: lg && !lg.ok ? lg.error : null, loginExpiresAt: lg?.expires ?? null, problems,
  };
}

// A busy host benchmarks slow, and a host never gets faster, so the score is the best seen, re-measured every 10 minutes
// and kept in the data dir: an agent that restarts on a busy host keeps what it measured while the host was quiet.
const scores = new Map<string, { score: number; at: number }>();
export function speed(file: string, now = Date.now()): number {
  let c = scores.get(file);
  if (!c) scores.set(file, (c = { score: Number(existsSync(file) ? readFileSync(file, "utf8") : 0) || 0, at: 0 }));
  if (!c.at || now - c.at >= 600_000) {
    const best = Math.max(c.score, bench());
    if (best > c.score) { c.score = best; try { writeFileSync(file, String(best)); } catch {} }
    c.at = now;
  }
  return c.score;
}

// Single-core speed: units per second of sorting 20k numbers and a JSON round trip,
// best of three 200 ms runs so a busy moment at start costs little. Plain JS on purpose: a hash benchmark rewards
// SHA instructions that compilers and test runners never use. The coordinator compares it across hosts.
export function bench(ms = 200): number {
  const unit = () => {
    const a = new Array<number>(20000);
    for (let i = 0, x = 1; i < a.length; i++) a[i] = x = (x * 1103515245 + 12345) & 0x7fffffff;
    a.sort((p, q) => p - q);
    return JSON.parse(JSON.stringify(a.slice(0, 2000))).length;
  };
  let best = 0;
  for (let r = 0; r < 3; r++) {
    let n = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { unit(); n++; }
    best = Math.max(best, n / ((performance.now() - t0) / 1000));
  }
  return Math.round(best);
}
