import { describe, expect, test } from "bun:test";
import { harness, hb, ready, submit, turnEnd } from "./helpers";

const state = (h: ReturnType<typeof harness>, id: string) => h.db.thread(id)!.state;

describe("placement", () => {
  test("places on a host after its doctor passes, with epoch and turn numbers", async () => {
    const h = harness();
    let open = () => {};
    h.agent.doctorGate = new Promise<void>((r) => (open = r));
    const id = submit(h);
    h.sched.onHeartbeat(hb("a"));
    await h.sched.tick();                       // starts the doctor, nothing to place on yet
    expect(state(h, id)).toBe("queued");
    open(); await h.sched.idle(); await h.sched.tick();
    expect(state(h, id)).toBe("running");
    const s = h.agent.started[0];
    expect(s.host).toBe("a");
    expect(s.b).toMatchObject({ thread: id, epoch: 1, turn: 1, resume: false, ref: "main", repoUrl: "git@x:o/app.git", rust: false });
    expect(h.db.thread(id)!.branch).toBe(`wd/${id}`);
  });

  test("repo without doctor needs none; failed doctor excludes the host and is rechecked after 10 min", async () => {
    const h = harness();
    h.agent.doctorOk.set("a|o/app", false);
    await ready(h, ["a"]);
    const id = submit(h);
    await h.sched.tick();
    expect(state(h, id)).toBe("queued");
    const rs = submit(h, { repo: "o/rs" });
    await h.sched.tick();
    expect(state(h, rs)).toBe("running");       // no doctor configured
    h.agent.doctorOk.set("a|o/app", true);
    h.advance(11 * 60_000); h.sched.onHeartbeat(hb("a"));
    await h.sched.tick(); await h.sched.idle(); await h.sched.tick();
    expect(state(h, id)).toBe("running");
  });

  test("labels: thread and repo requires must all be in the host labels", async () => {
    const h = harness();
    await ready(h, ["a"], { labels: ["linux"] });
    await ready(h, ["b"], { labels: ["linux", "gpu"] });
    const id = submit(h, { requires: ["gpu"] });
    await h.sched.tick();
    expect(h.agent.started.map((s) => s.host)).toEqual(["b"]);
    expect(state(h, id)).toBe("running");
    const none = submit(h, { requires: ["tpu"] });
    await h.sched.tick();
    expect(state(h, none)).toBe("queued");
  });

  test("floors: disk below the floor and memory below estimate + reserve are skipped", async () => {
    const h = harness();
    await ready(h, ["a"], { diskFreePct: 10 });
    await ready(h, ["b"], { memAvailMb: 2048 + 2048 - 1 });
    const id = submit(h);                       // small = 2048 MB estimate, + 2048 reserve
    await h.sched.tick();
    expect(state(h, id)).toBe("queued");
    h.sched.onHeartbeat(hb("b", { memAvailMb: 4096 }));
    await h.sched.tick();
    expect(h.agent.started[0].host).toBe("b");
  });

  test("heavy hint uses 8192 MB while there is no history", async () => {
    const h = harness();
    await ready(h, ["a"], { memAvailMb: 8000 });
    const id = submit(h, { size: "heavy" });
    await h.sched.tick();
    expect(state(h, id)).toBe("queued");
  });

  test("maxThreads from the heartbeat caps running threads per host", async () => {
    const h = harness();
    await ready(h, ["a"], { maxThreads: 1 });
    const t1 = submit(h), t2 = submit(h);
    await h.sched.tick();
    expect([state(h, t1), state(h, t2)]).toEqual(["running", "queued"]);
  });

  test("reservations: a running turn holds the part of its estimate it has not used yet, however long it has run", async () => {
    const h = harness();
    await ready(h, ["a"], { memAvailMb: 5000 });   // fits one small (2048+2048) but not two
    const t1 = submit(h), t2 = submit(h);
    await h.sched.tick();
    expect([state(h, t1), state(h, t2)]).toEqual(["running", "queued"]);
    const unit = (memPeakMb: number) => [{ thread: t1, epoch: 1, turn: 1, running: true, cpuMs: memPeakMb, memPeakMb }];
    h.advance(30 * 60_000); h.sched.onHeartbeat(hb("a", { memAvailMb: 5000, units: unit(500) }));
    await h.sched.tick();
    expect(state(h, t2)).toBe("queued");             // 5000 - (2048-500) - 2048 < 2048: t1 may still grow into its estimate
    h.sched.onHeartbeat(hb("a", { memAvailMb: 5000, units: unit(2048) }));
    await h.sched.tick();
    expect(state(h, t2)).toBe("running");            // t1 has reached its estimate, so what the probe shows is what is left
  });

  test("the size hint is a floor under the p90 of past peaks, so light turns cannot shrink a heavy thread's memory cap", async () => {
    const h = harness();
    await ready(h, ["a"], { memAvailMb: 30000 });
    const light = submit(h);
    await h.sched.tick();
    h.sched.onTurnEnd(turnEnd("a", light, 1, 1, { memPeakMb: 265 }));
    const heavy = submit(h, { size: "heavy" }), small = submit(h);
    await h.sched.tick();
    expect(h.db.turn(heavy, 1)).toMatchObject({ est_mb: 8192, mem_max: 16384 });
    expect(h.db.turn(small, 1)).toMatchObject({ est_mb: 2048, mem_max: 4096 });
  });

  test("most free memory after the estimate wins; priority then FIFO ordering", async () => {
    const h = harness();
    await ready(h, ["a"], { memAvailMb: 10000 });
    await ready(h, ["b"], { memAvailMb: 12000 });
    const lo = submit(h);
    h.advance(10);
    const hi = submit(h, { priority: true });
    await h.sched.tick();
    expect(h.agent.started.map((s) => [s.b.thread, s.host])).toEqual([[hi, "b"], [lo, "a"]]);
  });

  test("p90 of past peaks replaces the default, and an OOM raises the next estimate", async () => {
    const h = harness();
    await ready(h, ["a"], { memAvailMb: 30000 });
    const t1 = submit(h);
    await h.sched.tick();
    h.sched.onTurnEnd(turnEnd("a", t1, 1, 1, { memPeakMb: 6000 }));
    const t2 = submit(h);
    await h.sched.tick();
    expect(h.db.turn(t2, 1)!.est_mb).toBe(6000);
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun -e 'for(;;)a.push(1)'" } }] } });
    h.sched.onEvents({ host: "a", thread: t2, epoch: 1, turn: 1, offset: 0, lines: [line], nextOffset: line.length + 1 });
    h.sched.onTurnEnd(turnEnd("a", t2, 1, 1, { kind: "oom", result: null, memPeakMb: 100 }));
    expect(state(h, t2)).toBe("failed");
    expect(h.db.thread(t2)!.reason).toBe("oom: the turn reached its 12000 MB memory cap (2x its 6000 MB estimate; the host's free memory is not the limit)"
      + "; running: Bash: bun -e 'for(;;)a.push(1)'");
    const t3 = submit(h);
    await h.sched.tick();
    expect(h.db.turn(t3, 1)!.est_mb).toBeGreaterThan(6000);
  });

  test("a host's name is a label, so requires pins a thread to that host", async () => {
    const h = harness();
    await ready(h, ["a"], { memAvailMb: 30000 });
    await ready(h, ["b"], { memAvailMb: 9000 });
    const pinned = submit(h, { requires: ["b"] }), free = submit(h);
    await h.sched.tick();
    expect(h.db.thread(pinned)!.host).toBe("b");
    expect(h.db.thread(free)!.host).toBe("a");   // most free memory
  });

  test("refused hosts (login problem) never get work", async () => {
    const h = harness();
    await ready(h, ["a"], { loginOk: false });
    const id = submit(h);
    await h.sched.tick();
    expect(state(h, id)).toBe("queued");
  });

  test("unreachable agent rolls back to queued; a rejecting agent fails the thread with a final report", async () => {
    const h = harness();
    await ready(h, ["a"]);
    h.agent.down.add("a");
    const id = submit(h);
    await h.sched.tick();
    expect(h.db.thread(id)).toMatchObject({ state: "queued", host: null, turns: 0 });
    expect(h.db.get("SELECT 1 FROM turns WHERE thread=?", id)).toBeNull();
    h.agent.down.clear(); h.agent.rejectStart = "no such repo";
    await h.sched.tick();
    expect(state(h, id)).toBe("failed");
    const r = h.reports.pending("orch:x");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "final", state: "failed", isError: true, reason: "no such repo" });
  });

  test("rate_limit_event rejected holds starts until reset and is reported", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const t1 = submit(h);
    await h.sched.tick();
    const reset = Math.floor(h.clock.t / 1000) + 600;
    const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset } });
    expect(h.sched.onEvents({ host: "a", thread: t1, epoch: 1, turn: 1, offset: 0, lines: [line], nextOffset: line.length + 1 })).toEqual({ committed: line.length + 1 });
    expect(h.reports.pending("orch:x")[0].reason).toContain("held");
    const t2 = submit(h);
    await h.sched.tick();
    expect(state(h, t2)).toBe("queued");
    h.advance(601_000); h.sched.onHeartbeat(hb("a"));
    await h.sched.tick();
    expect(state(h, t2)).toBe("running");
  });
});

describe("events and turn end", () => {
  test("events apply exactly once; gaps and stale epochs are refused", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h);
    await h.sched.tick();
    const ev = (offset: number, next: number, epoch = 1) => ({ host: "a", thread: id, epoch, turn: 1, offset, lines: ["x"], nextOffset: next });
    expect(h.sched.onEvents(ev(0, 10))).toEqual({ committed: 10 });
    expect(h.sched.onEvents(ev(0, 10))).toEqual({ committed: 10 });      // resend
    expect(h.sched.onEvents(ev(50, 60))).toEqual({ committed: 10 });     // gap: agent must resend from 10
    expect(h.db.all("SELECT * FROM events WHERE thread=?", id)).toHaveLength(1);
    expect(h.sched.onEvents(ev(10, 20, 0))).toBeNull();
  });

  test("turn end: idle + turn report, cost is the difference of cumulative totals", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h, { tag: "T1" });
    await h.sched.tick();
    expect(h.sched.onTurnEnd(turnEnd("a", id, 1, 1))).toBe(true);
    expect(h.sched.onTurnEnd(turnEnd("a", id, 1, 1))).toBe(true);        // retried delivery is harmless
    expect(h.reports.pending("orch:x")).toHaveLength(1);
    const t = h.db.thread(id)!;
    expect(t).toMatchObject({ state: "idle", head: "abc123", cost: 1, last_message: "done" });
    h.sched.send(id, "more");
    await h.sched.tick();
    expect(h.agent.started[1].b).toMatchObject({ resume: true, turn: 2, epoch: 2, prompt: "more", sessionId: t.session_id });
    h.sched.onTurnEnd(turnEnd("a", id, 2, 2, { result: { isError: false, text: "again", totalCostUsd: 2.5, durationMs: 1000 } }));
    const rs = h.reports.pending("orch:x");
    expect(rs[1]).toMatchObject({ kind: "turn", tag: "T1", turnCostUsd: 1.5, message: "again", pushed: true });
    expect(rs[1].turnSeconds).toBe((h.clock.t - h.db.turn(id, 2)!.started) / 1000);   // wall time, not claude's duration_ms
  });

  test("launch-failed, timeout and is_error are reported with their reasons", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const a = submit(h), b = submit(h), c = submit(h);
    await h.sched.tick();
    h.sched.onTurnEnd(turnEnd("a", a, 1, 1, { kind: "launch-failed", result: null, stderrTail: "Not logged in" }));
    h.sched.onTurnEnd(turnEnd("a", b, 1, 1, { kind: "timeout", result: null }));
    h.sched.onTurnEnd(turnEnd("a", c, 1, 1, { result: { isError: true, text: "boom", totalCostUsd: 0, durationMs: 1 }, stderrTail: "err" }));
    expect([state(h, a), state(h, b), state(h, c)]).toEqual(["failed", "failed", "idle"]);
    expect(h.db.thread(a)!.reason).toBe("Not logged in");
    expect(h.db.thread(b)!.reason).toContain("cap");
    expect(h.reports.pending("orch:x").map((r) => r.isError)).toEqual([true, true, true]);
  });
});

describe("loss, sleep, stall", () => {
  test("a linux host silent past lostAfterSec: threads lost, epoch stale, reconnecting agent told to stop", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h);
    await h.sched.tick();
    h.advance(121_000);
    await h.sched.tick();
    expect(h.db.host("a")!.state).toBe("lost");
    expect(h.db.thread(id)).toMatchObject({ state: "lost", epoch: 2 });
    expect(h.reports.pending("orch:x")[0]).toMatchObject({ kind: "final", state: "lost", reason: "host lost" });
    // the host comes back still running the old epoch
    const reply = h.sched.onHeartbeat(hb("a", { units: [{ thread: id, epoch: 1, turn: 1, running: true, cpuMs: 5, memPeakMb: 1 }] }));
    expect(reply.stop).toEqual([{ thread: id, epoch: 1 }]);
    expect(h.sched.onTurnEnd(turnEnd("a", id, 1, 1))).toBe(true);        // already ended: ignored, nothing is double-applied
    expect(h.reports.pending("orch:x")).toHaveLength(1);
    // ended and the epoch moved on: a 409, so the agent drops the turn instead of resending the same batch forever
    expect(h.sched.onEvents({ host: "a", thread: id, epoch: 1, turn: 1, offset: 0, lines: ["x"], nextOffset: 2 })).toBeNull();
    expect(h.db.host("a")!.state).toBe("ok");
  });

  test("a darwin host goes asleep, not lost: one host-asleep report, placement skips it, wake clears it", async () => {
    const h = harness();
    await ready(h, ["a"], { os: "darwin" });
    const id = submit(h);
    await h.sched.tick();
    h.advance(121_000);
    await h.sched.tick(); await h.sched.tick();
    expect(h.db.host("a")!.state).toBe("asleep");
    expect(state(h, id)).toBe("running");
    const rs = h.reports.pending("orch:x");
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ kind: "turn", reason: "host-asleep", state: "running" });
    const q = submit(h);
    await h.sched.tick();
    expect(state(h, q)).toBe("queued");
    h.sched.onHeartbeat(hb("a", { os: "darwin" }));
    expect(h.db.thread(id)!.reason).toBeNull();
    await h.sched.tick();
    expect(state(h, q)).toBe("running");
  });

  test("asleep for more than 6 h becomes lost", async () => {
    const h = harness();
    await ready(h, ["a"], { os: "darwin" });
    const id = submit(h);
    await h.sched.tick();
    h.advance(6 * 3600_000 + 1000);
    await h.sched.tick();
    expect(state(h, id)).toBe("lost");
  });

  test("stall: no events and no cpu growth for stallMin; cpu growth or events keep it alive", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const busy = submit(h), dead = submit(h);
    await h.sched.tick();
    const unit = (t: string, cpu: number) => ({ thread: t, epoch: 1, turn: 1, running: true, cpuMs: cpu, memPeakMb: 10 });
    for (let i = 1; i <= 5; i++) {
      h.advance(5 * 60_000);
      h.sched.onHeartbeat(hb("a", { units: [unit(busy, i * 1000), unit(dead, 0)] }));
      await h.sched.tick();
    }
    expect(state(h, busy)).toBe("running");
    expect(state(h, dead)).toBe("stalled");
    expect(h.agent.stopped).toEqual([{ host: "a", b: { thread: dead, epoch: 1 } }]);
    expect(h.reports.pending("orch:x")[0]).toMatchObject({ state: "stalled", kind: "final" });
  });
});

describe("sends and cleanup", () => {
  test("send on an idle thread runs on the same host; if that host is lost the thread is lost", async () => {
    const h = harness();
    await ready(h, ["a", "b"], { memAvailMb: 9000 });
    h.sched.onHeartbeat(hb("b", { memAvailMb: 30000 }));
    const id = submit(h);
    await h.sched.tick();
    expect(h.agent.started[0].host).toBe("b");
    h.sched.onTurnEnd(turnEnd("b", id, 1, 1));
    h.sched.send(id, "one"); h.sched.send(id, "two");
    await h.sched.tick();
    expect(h.agent.started[1]).toMatchObject({ host: "b", b: { prompt: "one\n\ntwo", resume: true } });
    expect(h.db.all("SELECT * FROM sends")).toHaveLength(0);
    h.sched.onTurnEnd(turnEnd("b", id, 2, 2));
    h.sched.send(id, "three");
    h.advance(121_000); h.sched.onHeartbeat(hb("a", { memAvailMb: 9000 }));
    await h.sched.tick();
    expect(state(h, id)).toBe("lost");
  });

  test("send to a busy thread is queued; to a final thread is a 409", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h);
    await h.sched.tick();
    expect(h.sched.send(id, "later")).toEqual({ queued: 1 });
    await h.sched.cancel(id);
    expect(() => h.sched.send(id, "x")).toThrow("cannot send");
  });

  test("cancel: running turn is stopped with the old epoch, then the epoch is stale", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h), q = submit(h, { requires: ["none"] });
    await h.sched.tick();
    await h.sched.cancel(id); await h.sched.cancel(q);
    expect(h.agent.stopped[0].b).toEqual({ thread: id, epoch: 1 });
    expect([state(h, id), state(h, q)]).toEqual(["cancelled", "cancelled"]);
    expect(h.sched.onTurnEnd(turnEnd("a", id, 1, 1))).toBe(true);
    expect(h.reports.pending("orch:x")).toHaveLength(2);
  });

  test("release: idle thread becomes done without a report (the caller asked) and the agent frees the worktree; failures retry", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h);
    await h.sched.tick();
    h.sched.onTurnEnd(turnEnd("a", id, 1, 1));
    h.agent.down.add("a");
    await h.sched.release(id);
    expect(h.db.thread(id)).toMatchObject({ state: "done", released: 0 });
    h.agent.down.clear();
    await h.sched.tick();
    expect(h.agent.released).toEqual([{ host: "a", b: { thread: id } }]);
    expect(h.db.thread(id)!.released).toBe(1);
    expect(h.reports.pending("orch:x").map((r) => r.kind)).toEqual(["turn"]);
    expect(() => h.sched.release("nope")).toThrow();
  });

  test("ttl: an idle thread past ttlHours becomes done and is released; final threads are released after 24 h", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h, { ttlHours: 1 }), f = submit(h);
    await h.sched.tick();
    h.sched.onTurnEnd(turnEnd("a", id, 1, 1));
    h.sched.onTurnEnd(turnEnd("a", f, 1, 1, { kind: "launch-failed", result: null }));
    h.advance(3_700_000); h.sched.onHeartbeat(hb("a"));
    await h.sched.tick();
    expect(state(h, id)).toBe("done");
    expect(h.agent.released.map((r) => r.b.thread)).toEqual([id]);
    h.advance(24 * 3600_000); h.sched.onHeartbeat(hb("a"));
    await h.sched.tick();
    expect(h.agent.released.map((r) => r.b.thread)).toEqual([id, f]);
  });
});

describe("review fixes", () => {
  test("a batch overlapping the committed offset is not accepted: the agent is told where to resume", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h);
    await h.sched.tick();
    const ev = (offset: number, next: number, lines: string[]) => ({ host: "a", thread: id, epoch: 1, turn: 1, offset, lines, nextOffset: next });
    expect(h.sched.onEvents(ev(0, 10, ["a"]))).toEqual({ committed: 10 });
    expect(h.sched.onEvents(ev(0, 30, ["a", "b", "c"]))).toEqual({ committed: 10 });   // reply of the first was lost, resent with more
    expect(h.db.turn(id, 1)!.committed).toBe(10);
    expect(h.sched.onEvents(ev(10, 30, ["b", "c"]))).toEqual({ committed: 30 });
    expect(h.db.all<{ offset: number }>('SELECT "offset" FROM events WHERE thread=? ORDER BY "offset"', id).map((r) => r.offset)).toEqual([0, 10]);
  });

  test("a stalled or cancelled turn's events get a 409 too", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h);
    await h.sched.tick();
    await h.sched.cancel(id);
    expect(h.sched.onEvents({ host: "a", thread: id, epoch: 1, turn: 1, offset: 0, lines: ["x"], nextOffset: 2 })).toBeNull();
  });

  test("cancel of a queued thread while another start is in flight: it stays cancelled", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const a = submit(h), b = submit(h);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = h.agent.start.bind(h.agent);
    h.agent.start = async (host, body) => { if (body.thread === a) await gate; return orig(host, body); };
    const tick = h.sched.tick();
    await Bun.sleep(20);
    await h.sched.cancel(b);
    release();
    await tick;
    expect(state(h, b)).toBe("cancelled");
    expect(h.agent.started.map((x) => x.b.thread)).toEqual([a]);
    expect(h.db.thread(b)!.turns).toBe(0);
  });

  test("cancel of a thread whose start then fails: no rollback to queued, no second start", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h);
    let fail!: () => void;
    const gate = new Promise<void>((_, rej) => (fail = () => rej(new Error("timeout"))));
    h.agent.start = async () => { await gate; return { ok: true }; };
    const tick = h.sched.tick();
    await Bun.sleep(20);
    await h.sched.cancel(id);
    fail();
    await tick;
    expect(state(h, id)).toBe("cancelled");
    expect(h.reports.pending("orch:x")).toHaveLength(1);
    await h.sched.tick();
    expect(state(h, id)).toBe("cancelled");
  });

  test("release or cancel of an idle thread during sends() skips its follow-up and does not throw", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const x = submit(h), y = submit(h);
    await h.sched.tick();
    h.sched.onTurnEnd(turnEnd("a", x, 1, 1)); h.sched.onTurnEnd(turnEnd("a", y, 1, 1));
    h.sched.send(x, "one"); h.sched.send(y, "two");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = h.agent.start.bind(h.agent);
    h.agent.start = async (host, body) => { if (body.thread === x) await gate; return orig(host, body); };
    const tick = h.sched.tick();
    await Bun.sleep(20);
    await h.sched.release(y);
    release();
    await tick;
    expect(state(h, y)).toBe("done");
    expect(h.agent.started.filter((s) => s.b.thread === y)).toHaveLength(1);   // only its first turn
  });

  test("follow-up turns are held during a rate-limit hold", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h);
    await h.sched.tick();
    h.sched.onTurnEnd(turnEnd("a", id, 1, 1));
    h.db.setMeta("hold_until", String(h.clock.t + 600_000));
    h.sched.send(id, "more");
    await h.sched.tick();
    expect(h.agent.started).toHaveLength(1);
    h.advance(601_000); h.sched.onHeartbeat(hb("a"));
    await h.sched.tick();
    expect(h.agent.started).toHaveLength(2);
  });

  test("stall: any change in cpu counts as activity, not only growth above the peak", async () => {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h);
    await h.sched.tick();
    const unit = (cpu: number) => ({ thread: id, epoch: 1, turn: 1, running: true, cpuMs: cpu, memPeakMb: 10 });
    h.sched.onHeartbeat(hb("a", { units: [unit(50_000)] }));   // an early peak
    for (let i = 0; i < 5; i++) {
      h.advance(5 * 60_000);
      h.sched.onHeartbeat(hb("a", { units: [unit(1000 + i * 500)] }));   // lower, but moving
      await h.sched.tick();
    }
    expect(state(h, id)).toBe("running");
  });
});
