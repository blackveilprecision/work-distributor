import { describe, expect, test } from "bun:test";
import { makeHandler } from "../../src/coord/api";
import { harness, hb, ready, submit, turnEnd } from "./helpers";

const RESUME = "You were interrupted by a host restart. Continue where you left off.";
const state = (h: ReturnType<typeof harness>, id: string) => h.db.thread(id)!.state;
const lost = (host: string, id: string, epoch: number, turn: number) => turnEnd(host, id, epoch, turn, { kind: "lost", exitCode: null, result: null, head: "abc123", pushed: true });

describe("GET /agent/threads", () => {
  test("lists every thread that is not final, plus that host's final threads not yet released", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const running = submit(h), idle = submit(h), done = submit(h), freed = submit(h), other = submit(h, { requires: ["x"] });
    await h.sched.tick();
    const host = "a";
    for (const id of [idle, done, freed]) h.sched.onTurnEnd(turnEnd(host, id, 1, 1));
    await h.sched.release(done); await h.sched.release(freed);
    h.db.setThread(done, { released: 0 });                 // its release did not go through yet
    expect(state(h, done)).toBe("done");
    expect(state(h, other)).toBe("queued");
    expect(h.sched.liveThreads(host).sort()).toEqual([running, idle, done, other].sort());
    expect(h.db.thread(freed)).toMatchObject({ state: "done", released: 1 });
    // Another host keeps the non-final threads (a queued thread may start there) but not this host's final one.
    expect(h.sched.liveThreads("b").sort()).toEqual([running, idle, other].sort());
  });

  test("a thread requeued off a host (host=NULL, start abandoned) stays listed for that host so the sweep spares its worktree", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h);
    await h.sched.tick();
    h.db.setThread(id, { state: "queued", host: null });   // what launch() does when the first /start is given up on
    expect(h.sched.liveThreads("a")).toEqual([id]);
    h.db.setThread(id, { state: "cancelled", host: null, released: 1 });
    expect(h.sched.liveThreads("a")).toEqual([]);
  });

  test("the route needs that host's own token and name, and answers a GET", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h);
    await h.sched.tick();
    const handle = makeHandler(h.sched, h.reports);
    const get = async (path: string, token: string) => {
      const r = await handle(new Request("http://x" + path, { headers: { authorization: `Bearer ${token}` } }));
      return { status: r.status, body: (await r.json()) as any };
    };
    expect(await get("/agent/threads?host=a", "ta")).toEqual({ status: 200, body: { threads: [id] } });
    expect((await get("/agent/threads?host=a", "tb")).status).toBe(401);
    expect((await get("/agent/threads?host=a", "ct")).status).toBe(401);
    expect((await get("/agent/threads", "ta")).status).toBe(401);
  });
});

describe("resume after a host restart", () => {
  async function running(over: Parameters<typeof ready>[2] = {}) {
    const h = harness();
    await ready(h, ["a"], over);
    const id = submit(h);
    await h.sched.tick();
    return { h, id };
  }

  test("a vanished turn is not failed: a follow-up with resume:true goes to the same host once it is ok, with a non-final report", async () => {
    const { h, id } = await running();
    expect(h.sched.onTurnEnd(lost("a", id, 1, 1))).toBe(true);
    expect(h.db.thread(id)).toMatchObject({ state: "idle", reason: "host-restart: resuming" });
    const rs = h.reports.pending("orch:x");
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ kind: "turn", reason: "host-restart: resuming", isError: false, pushed: true });
    h.sched.onHeartbeat(hb("a", { problems: ["disk"] }));   // still booting: not ok yet
    await h.sched.tick();
    expect(h.agent.started).toHaveLength(1);
    h.sched.onHeartbeat(hb("a"));
    await h.sched.tick();
    expect(h.agent.started).toHaveLength(2);
    expect(h.agent.started[1]).toMatchObject({ host: "a", b: { thread: id, epoch: 2, turn: 2, resume: true, prompt: RESUME, sessionId: h.db.thread(id)!.session_id } });
    expect(h.db.thread(id)).toMatchObject({ state: "running", reason: null });
    h.sched.onTurnEnd(turnEnd("a", id, 2, 2));
    expect(h.reports.pending("orch:x").map((r) => [r.kind, r.state])).toEqual([["turn", "idle"], ["turn", "idle"]]);
  });

  test("a second vanished turn in a row fails the thread with a final report", async () => {
    const { h, id } = await running();
    h.sched.onTurnEnd(lost("a", id, 1, 1));
    await h.sched.tick();
    h.sched.onTurnEnd(lost("a", id, 2, 2));
    expect(h.db.thread(id)).toMatchObject({ state: "lost", reason: "lost twice" });
    const rs = h.reports.pending("orch:x");
    expect(rs.map((r) => r.kind)).toEqual(["turn", "final"]);
    expect(rs[1]).toMatchObject({ state: "lost", reason: "lost twice", isError: true });
    await h.sched.tick();
    expect(h.agent.started).toHaveLength(2);   // no third turn
  });

  test("only consecutive vanishes count: a resumed turn that finishes re-arms the resume", async () => {
    const { h, id } = await running();
    h.sched.onTurnEnd(lost("a", id, 1, 1)); await h.sched.tick();
    h.sched.onTurnEnd(turnEnd("a", id, 2, 2)); h.sched.send(id, "next"); await h.sched.tick();
    h.sched.onTurnEnd(lost("a", id, 3, 3));
    expect(state(h, id)).toBe("idle");
    await h.sched.tick();
    expect(h.agent.started[3].b).toMatchObject({ turn: 4, resume: true, prompt: RESUME });
  });

  test("a stale or repeated turn-end does not queue a resume; a restart that loses no turn never does", async () => {
    const { h, id } = await running();
    expect(h.sched.onTurnEnd(lost("a", id, 7, 1))).toBe(false);          // wrong epoch
    expect(state(h, id)).toBe("running");
    h.sched.onTurnEnd(lost("a", id, 1, 1));
    expect(h.sched.onTurnEnd(lost("a", id, 1, 1))).toBe(true);           // retried delivery
    expect(h.db.all("SELECT 1 FROM sends WHERE thread=?", id)).toHaveLength(1);
    const k = await running();                                           // exited, oom and the rest never resume
    k.h.sched.onTurnEnd(turnEnd("a", k.id, 1, 1, { kind: "oom", result: null }));
    expect(state(k.h, k.id)).toBe("failed");
    expect(k.h.db.all("SELECT 1 FROM sends")).toHaveLength(0);
  });

  test("the pending resume waits like any follow-up: a lost host loses the thread, a cancel cancels it", async () => {
    const a = await running();
    a.h.sched.onTurnEnd(lost("a", a.id, 1, 1));
    a.h.advance(200_000);
    await a.h.sched.tick();
    expect(a.h.db.thread(a.id)).toMatchObject({ state: "lost", reason: "host lost before the follow-up could start" });
    const b = await running();
    b.h.sched.onTurnEnd(lost("a", b.id, 1, 1));
    await b.h.sched.cancel(b.id);
    await b.h.sched.tick();
    expect(state(b.h, b.id)).toBe("cancelled");
    expect(b.h.agent.started).toHaveLength(1);
  });
});
