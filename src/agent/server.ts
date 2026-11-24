// The agent's HTTP side (start, stop, release, doctor, probe), the heartbeat loop and the restart recovery.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DoctorRequest, DoctorResult, Heartbeat, HeartbeatReply, Release, StartTurn, StopTurn, TurnEnd, UnitStatus } from "../shared/types";
import { type AgentConfig, lastChars, loginPath, post, run, sleep } from "./config";
import { launch, readMeta, stopTurn, turnDir, turnKey } from "./launch";
import { probe } from "./probe";
import { SWEEP_EVERY_MS, sweepOrphans } from "./sweep";
import { type Active, type Ctx, tailTurn } from "./tail";
import { ensureMirror, git, leaseTarget, prepareWorktree, releaseTarget, releaseWorktree, wtPath } from "./workspace";

export { VERSION } from "../shared/version";
import { replaceBinary, wantUpdate } from "./update";
import { VERSION } from "../shared/version";

function track(ctx: Ctx, meta: ReturnType<typeof readMeta>) {
  const a: Active = { meta, cpuMs: 0, memPeakMb: 0, running: true, stale: false, done: Promise.resolve() };
  ctx.active.set(meta.key, a);
  a.done = tailTurn(ctx, a).catch((e) => console.error(`tail ${meta.key} crashed:`, e));
}

class Refused extends Error {}

// Accepting a start is quick: it checks, then prepares and launches in the background, because a first clone can take
// minutes and the coordinator would give up long before and start the same thread again. A failure there comes back as
// a launch-failed turn-end. One thread runs one turn at a time: a start for a different epoch while one is live or
// being prepared is refused.
async function start(ctx: Ctx, s: StartTurn): Promise<void> {
  const { cfg } = ctx, key = turnKey(s), dir = turnDir(cfg, key);
  if (ctx.active.has(key) || ctx.preparing.has(key) || existsSync(join(dir, "meta.json"))) return;   // a retried start of a turn we already have
  for (const a of ctx.active.values()) if (a.meta.s.thread === s.thread && a.running && !a.stale) throw new Refused(`thread ${s.thread} already has a live turn (epoch ${a.meta.s.epoch})`);
  for (const p of ctx.preparing.values()) if (p.thread === s.thread) throw new Refused(`thread ${s.thread} is already being prepared (epoch ${p.epoch})`);
  if (s.resume && !existsSync(wtPath(cfg, s.thread))) throw new Error(`worktree for ${s.thread} is gone, cannot resume`);
  ctx.preparing.set(key, s);
  void (async () => {
    let target: string | null = null;
    try {
      const wt = await prepareWorktree(cfg, s);
      target = s.rust ? leaseTarget(cfg, s.repoId, key, (k) => ctx.active.has(k)) : null;
      track(ctx, await launch(cfg, s, wt, target));
    } catch (e) {
      releaseTarget(target);
      rmSync(dir, { recursive: true, force: true });
      await failStart(ctx, s, (e as Error).message);
    } finally {
      ctx.preparing.delete(key);
    }
  })();
}

async function failStart(ctx: Ctx, s: StartTurn, msg: string) {
  const te: TurnEnd = { host: ctx.cfg.name, thread: s.thread, epoch: s.epoch, turn: s.turn, exitCode: null, kind: "launch-failed", stderrTail: lastChars(msg), result: null, head: null, pushed: false, pushError: null, memPeakMb: 0 };
  for (let wait = ctx.cfg.tailMs, i = 0; i < 40 && !ctx.closed; wait = Math.min(wait * 2, 30_000), i++) {
    const r = await post(ctx.cfg, "/agent/turn-end", te);
    if (r.status >= 200 && r.status < 500) return;
    await sleep(wait);
  }
}

// Stopped by the coordinator or a heartbeat: its epoch is dead, so nothing of this turn may be committed, pushed or
// reported any more (the work of a newer turn may be sitting in the same worktree).
async function stop(ctx: Ctx, st: StopTurn) {
  for (const a of ctx.active.values()) if (a.meta.s.thread === st.thread && a.meta.s.epoch === st.epoch) { a.stale = true; await stopTurn(a.meta, "stale"); }
}

async function release(ctx: Ctx, r: Release) {
  const { cfg } = ctx;
  for (const a of [...ctx.active.values()].filter((a) => a.meta.s.thread === r.thread)) { a.stale = true; await stopTurn(a.meta, "stale"); await a.done; }
  await releaseWorktree(cfg, r.thread);
  const turns = join(cfg.dataDir, "turns");
  if (existsSync(turns)) for (const n of readdirSync(turns)) if (new RegExp(`^${r.thread}-\\d+-\\d+$`).test(n)) rmSync(join(turns, n), { recursive: true, force: true });
}

async function doctor(cfg: AgentConfig, r: DoctorRequest): Promise<DoctorResult> {
  try {
    const mirror = await ensureMirror(cfg, r.repoId, r.repoUrl);
    const wt = join(cfg.dataDir, "doctor", r.repoId.replaceAll("/", "__"));
    rmSync(wt, { recursive: true, force: true });
    mkdirSync(join(cfg.dataDir, "doctor"), { recursive: true });
    const w = await git(cfg, mirror, ["worktree", "add", "-q", "--detach", wt, "HEAD"]);
    if (!w.ok) return { ok: false, output: lastChars(`worktree: ${w.err}`) };
    try {
      const c = await run(["/bin/sh", "-c", r.command], { cwd: wt, timeout: 600_000, env: { ...process.env, PATH: cfg.path ?? process.env.PATH } });
      return { ok: c.ok, output: lastChars([c.out, c.err].filter(Boolean).join("\n")) };
    } finally {
      await git(cfg, mirror, ["worktree", "remove", "--force", wt]);
      rmSync(wt, { recursive: true, force: true });
    }
  } catch (e) {
    return { ok: false, output: lastChars((e as Error).message) };
  }
}

async function beat(ctx: Ctx) {
  const { cfg } = ctx;
  const p = await probe(cfg).catch((e) => ({
    os: process.platform === "linux" ? "linux" : "darwin", cores: 0, memTotalMb: 0, memAvailMb: 0, diskFreePct: 0, diskFreeGb: 0,
    claudeVersion: null, loginOk: false, loginError: null, loginExpiresAt: null, problems: [`probe failed: ${(e as Error).message}`],
  } as const));
  const units: UnitStatus[] = [...ctx.active.values()].map((a) => ({ thread: a.meta.s.thread, epoch: a.meta.s.epoch, turn: a.meta.s.turn, running: a.running, cpuMs: Math.round(a.cpuMs), memPeakMb: Math.round(a.memPeakMb) }));
  const hb: Heartbeat = { host: cfg.name, agentVersion: VERSION, probe: p as Heartbeat["probe"], units, labels: cfg.labels, maxThreads: cfg.maxThreads };
  const r = await post(cfg, "/agent/heartbeat", hb);
  // The coordinator names turns whose epoch is stale or whose thread was cancelled; they die here.
  if (r.status !== 200) return;
  const reply = r.body as HeartbeatReply | null;
  for (const st of reply?.stop ?? []) void stop(ctx, st);
  if (!ctx.preparing.size && wantUpdate(reply?.version, cfg.autoUpdate)) {   // not while a worktree is being set up for a start
    try {
      await replaceBinary(reply!.version!, process.execPath);
      console.error(`wd agent: updated ${VERSION} -> ${reply!.version}; exiting for the service manager to restart it`);
      process.exit(0);
    } catch (e) { console.error(`wd agent: update to ${reply!.version} failed (retrying in an hour):`, (e as Error).message); }
  }
}

export async function startAgent(cfg: AgentConfig) {
  mkdirSync(cfg.dataDir, { recursive: true });
  cfg.path ??= await loginPath();
  const ctx: Ctx = { cfg, version: VERSION, active: new Map(), preparing: new Map(), closed: false };
  // Resume tailing every turn that never wrote `ended`: its process may well have kept running while we were down.
  const turns = join(cfg.dataDir, "turns");
  if (existsSync(turns)) for (const n of readdirSync(turns)) {
    const dir = join(turns, n);
    if (existsSync(join(dir, "meta.json")) && !existsSync(join(dir, "ended"))) track(ctx, readMeta(dir));
  }

  const [hostname, port] = [cfg.listen.slice(0, cfg.listen.lastIndexOf(":")), Number(cfg.listen.slice(cfg.listen.lastIndexOf(":") + 1))];
  const json = (o: unknown, status = 200) => Response.json(o, { status });
  const server = Bun.serve({
    hostname, port,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${cfg.token}`) return json({ error: "unauthorized" }, 401);
      const path = new URL(req.url).pathname;
      try {
        if (req.method === "GET" && path === "/probe") return json(await probe(cfg));
        if (req.method !== "POST") return json({ error: "not found" }, 404);
        const b: any = await req.json().catch(() => null);
        if (!b || typeof b !== "object") return json({ error: "json body required" }, 400);
        if (path === "/start") {
          for (const k of ["thread", "repoUrl", "repoId", "ref", "branch", "sessionId", "prompt"]) if (typeof b[k] !== "string") return json({ error: `start: ${k} must be a string` }, 400);
          await start(ctx, b as StartTurn);
          return json({ ok: true });
        }
        if (path === "/stop") { await stop(ctx, b); return json({ ok: true }); }
        if (path === "/release") { await release(ctx, b); return json({ ok: true }); }
        if (path === "/doctor") return json(await doctor(cfg, b));
        return json({ error: "not found" }, 404);
      } catch (e) {
        return json({ error: (e as Error).message }, e instanceof Refused ? 409 : 500);
      }
    },
  });

  void (async () => {
    while (!ctx.closed) {
      await beat(ctx).catch((e) => console.error("heartbeat:", e));
      await new Promise<void>((r) => setTimeout(r, cfg.heartbeatSec * 1000).unref());   // unref'd so a stopped agent exits at once, not after the sleep
    }
  })();

  // The first sweep waits for the turns above to be tailed again; the timer is unref'd so it never holds a stopped agent up.
  void (async () => {
    while (!ctx.closed) {
      await sweepOrphans(ctx).catch((e) => console.error("orphan sweep:", e));
      await new Promise<void>((r) => setTimeout(r, SWEEP_EVERY_MS).unref());
    }
  })();

  // Closing leaves turns running: they are detached on purpose, and the next agent picks their tails up.
  return { port: server.port, ctx, close: async () => { ctx.closed = true; await server.stop(true); } };
}
