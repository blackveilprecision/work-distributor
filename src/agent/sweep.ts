// Orphan sweep: what is left on disk for threads the coordinator no longer holds (a release that never arrived, a thread
// lost with its host, an agent that crashed mid-turn). The coordinator's list is the only authority: without it, nothing
// is removed. A thread with a turn that may still run is never touched, and neither is anything younger than a day, which
// also covers a start the coordinator has claimed but this agent has not been told about yet.
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentThreads } from "../shared/types";
import { get } from "./config";
import { readMeta, status } from "./launch";
import type { Ctx } from "./tail";
import { git, releaseWorktree } from "./workspace";

export const SWEEP_EVERY_MS = 6 * 3600_000;
const OLD_MS = 24 * 3600_000;
const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const threadOf = (turnKey: string) => turnKey.replace(/-\d+-\d+$/, "");
const old = (p: string) => { try { return Date.now() - statSync(p).mtimeMs > OLD_MS; } catch { return false; } };

// True when a turn of this thread is tailed, being prepared, or has a live process (an unreadable meta counts as live).
async function busy(ctx: Ctx, thread: string): Promise<boolean> {
  if ([...ctx.active.values()].some((a) => a.meta.s.thread === thread) || [...ctx.preparing.values()].some((s) => s.thread === thread)) return true;
  const turns = join(ctx.cfg.dataDir, "turns");
  for (const n of ls(turns)) {
    const dir = join(turns, n);
    if (threadOf(n) !== thread || !existsSync(join(dir, "meta.json")) || existsSync(join(dir, "ended"))) continue;
    try { if ((await status(readMeta(dir))).running) return true; } catch { return true; }
  }
  return false;
}

// Returns what it removed, one line each (also logged).
export async function sweepOrphans(ctx: Ctx): Promise<string[]> {
  const { cfg } = ctx, removed: string[] = [];
  const r = await get(cfg, `/agent/threads?host=${encodeURIComponent(cfg.name)}`);
  const list = (r.body as AgentThreads | null)?.threads;
  if (r.status !== 200 || !Array.isArray(list)) return removed;
  const live = new Set(list);
  const orphan = async (thread: string, path: string) => !live.has(thread) && old(path) && !(await busy(ctx, thread));
  const did = (what: string) => { removed.push(what); console.log(`wd agent: orphan sweep removed ${what}`); };

  const wt = join(cfg.dataDir, "wt");
  for (const n of ls(wt)) {
    const path = join(wt, n);
    if (n.endsWith(".base") && existsSync(path.slice(0, -5))) continue;   // goes with its worktree
    const thread = n.endsWith(".base") ? n.slice(0, -5) : n;
    if (!(await orphan(thread, path))) continue;
    await releaseWorktree(cfg, thread);   // also removes a lone .base file
    did(`worktree ${thread}`);
  }
  const turns = join(cfg.dataDir, "turns");
  for (const n of ls(turns)) {
    if (!(await orphan(threadOf(n), join(turns, n)))) continue;   // busy() has ruled out a live process, ended marker or not
    rmSync(join(turns, n), { recursive: true, force: true });
    did(`turn dir ${n}`);
  }
  const targets = join(cfg.dataDir, "target");
  for (const repo of ls(targets)) for (const n of ls(join(targets, repo)).filter((n) => n.endsWith(".lock"))) {
    const lock = join(targets, repo, n), keyFile = join(lock, "key");
    if (!(await orphan(threadOf(existsSync(keyFile) ? readFileSync(keyFile, "utf8") : ""), lock))) continue;
    rmSync(lock, { recursive: true, force: true });
    did(`target lease ${repo}/${n.slice(0, -5)}`);
  }
  // A worktree being added would look half-made to prune, so it waits for the next sweep.
  const repos = join(cfg.dataDir, "repos");
  if (!ctx.preparing.size) for (const n of ls(repos).filter((n) => n.endsWith(".git"))) await git(cfg, join(repos, n), ["worktree", "prune"]);
  return removed;
}
