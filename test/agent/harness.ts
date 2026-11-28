// Shared setup: a local bare repo as origin, fake-claude behind a wrapper script, and a fake coordinator that records
// what the agent sends and applies the same commit rule as the real one (a batch is taken only at the committed offset).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartTurn, StopTurn, TurnEnd } from "../../src/shared/types";
import type { AgentConfig } from "../../src/agent/config";
import { startAgent } from "../../src/agent/server";

export const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
export async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 20_000, what = "condition"): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(40)) { const v = await fn(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}

export class FakeCoord {
  reqs: { path: string; body: any }[] = [];
  committed = new Map<string, number>();
  lines = new Map<string, string[]>();
  stale = new Set<string>();           // thread ids answered with 409
  stopReply: StopTurn[] = [];
  failEvents = 0;                      // answer the next n events posts with 500
  failTurnEnd = false;
  live: string[] | null = null;        // answer to GET /agent/threads; null means the request fails
  frozen = false;                      // answer events with 200 but never advance committed
  port = 0;
  private server: ReturnType<typeof Bun.serve> | null = null;
  up() {
    this.server = Bun.serve({
      hostname: "127.0.0.1", port: this.port,
      fetch: async (req) => {
        const path = new URL(req.url).pathname, body: any = await req.json().catch(() => null);
        if (req.headers.get("authorization") !== "Bearer tok") return Response.json({ error: "auth" }, { status: 401 });
        this.reqs.push({ path, body });
        if (body?.thread && this.stale.has(body.thread)) return Response.json({ error: "stale epoch" }, { status: 409 });
        if (path === "/agent/threads") return this.live ? Response.json({ threads: this.live }) : Response.json({ error: "down" }, { status: 503 });
        if (path === "/agent/heartbeat") return Response.json({ stop: this.stopReply });
        if (path === "/agent/turn-end" && this.failTurnEnd) return Response.json({ error: "boom" }, { status: 503 });
        if (path === "/agent/events") {
          if (this.failEvents > 0) { this.failEvents--; return Response.json({ error: "boom" }, { status: 500 }); }
          const key = `${body.thread}-${body.epoch}-${body.turn}`, at = this.committed.get(key) ?? 0;
          if (body.offset === at && !this.frozen) { this.committed.set(key, body.nextOffset); this.lines.set(key, [...(this.lines.get(key) ?? []), ...body.lines]); }
          return Response.json({ committed: this.committed.get(key) ?? 0 });
        }
        return Response.json({ ok: true });
      },
    });
    this.port = this.server.port!;
  }
  down() { this.server?.stop(true); this.server = null; }
  get url() { return `http://127.0.0.1:${this.port}`; }
  of(path: string) { return this.reqs.filter((r) => r.path === path).map((r) => r.body); }
  ends(thread?: string): TurnEnd[] { return this.of("/agent/turn-end").filter((b) => !thread || b.thread === thread); }
}

export async function harness(over: Partial<AgentConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "wd-agent-"));
  const origin = join(root, "origin.git");
  sh(root, "git", "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  sh(root, "git", "clone", "-q", origin, seed);
  writeFileSync(join(seed, "README"), "seed\n");
  sh(seed, "git", "add", "README");
  sh(seed, "git", "commit", "-qm", "seed");
  sh(seed, "git", "push", "-q", "origin", "HEAD:main");

  const claude = join(root, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "../fake-claude.ts"))} "$@"\n`);
  chmodSync(claude, 0o755);

  const coord = new FakeCoord();
  coord.up();
  const cfg: AgentConfig = {
    name: "testhost", listen: "127.0.0.1:0", coordUrl: coord.url, token: "tok", dataDir: join(root, "data"), claude,
    labels: [], maxThreads: 4, heartbeatSec: 3600, tailMs: 40, pushEverySec: 3600, path: process.env.PATH, ...over,
  };
  const agents: Awaited<ReturnType<typeof startAgent>>[] = [];
  const spawn = async () => { const a = await startAgent(cfg); agents.push(a); return a; };
  let agent = await spawn();
  const call = async (path: string, body?: unknown, a = agent) => {
    const r = await fetch(`http://127.0.0.1:${a.port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer tok" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const turn = (o: Partial<StartTurn> = {}): StartTurn => ({
    thread: "t1", epoch: 1, turn: 1, repoUrl: origin, repoId: "acme/app", ref: "main", branch: "wd/t1", sessionId: crypto.randomUUID(),
    resume: false, prompt: "hello", memoryMaxMb: 1024, runtimeMaxSec: 60, ...o,
  });
  return {
    root, origin, cfg, coord, call, turn, get agent() { return agent },
    restartAgent: async () => { await agent.close(); agent = await spawn(); return agent; },
    turnDir: (t: StartTurn) => join(cfg.dataDir, "turns", `${t.thread}-${t.epoch}-${t.turn}`),
    originHead: (branch: string) => { try { return sh(origin, "git", "rev-parse", branch); } catch { return null; } },
    async cleanup() {
      for (const a of agents) { for (const x of a.ctx.active.values()) { try { process.kill(-x.meta.pid!, "SIGKILL"); } catch {} } await a.close(); }
      coord.down();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export { existsSync, readFileSync, mkdirSync };
