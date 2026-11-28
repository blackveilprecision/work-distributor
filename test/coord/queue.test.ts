import { describe, expect, test } from "bun:test";
import { hostViews, makeHandler } from "../../src/coord/api";
import { queueText } from "../../src/cli/main";
import { harness, hb, ready, submit, turnEnd, type H } from "./helpers";

const queue = (h: H) => h.sched.queue(hostViews(h.sched));

describe("GET /queue", () => {
  test("running threads per host, with capacity, and queued threads in placement order with why they wait", async () => {
    const h = harness();
    await ready(h, ["a"], { maxThreads: 1 });
    const run = submit(h, { tag: "r" });
    await h.sched.tick();
    h.advance(10);
    const lo = submit(h, { tag: "lo" });
    h.advance(10);
    const hi = submit(h, { priority: true });
    const q = queue(h);
    expect(q.holdUntil).toBeNull();
    expect(q.queued.map((t) => [t.id, t.priority, t.estimateMb, t.waiting])).toEqual([[hi, true, 2048, "a: full 1/1"], [lo, false, 2048, "a: full 1/1"]]);
    const a = q.hosts.find((x) => x.name === "a")!;
    expect(a).toMatchObject({ state: "ok", running: 1, maxThreads: 1 });
    expect(a.threads).toEqual([{ id: run, caller: "orch:x", repo: "o/app", tag: "r", turn: 1, startedAt: h.clock.t - 20, activity: null }]);
    expect(q.hosts.find((x) => x.name === "b")).toMatchObject({ state: "lost", reason: "never seen", threads: [] });
  });

  test("each host's reason: labels, doctor, disk, memory; null once some host fits", async () => {
    const h = harness();
    h.agent.doctorOk.set("b|o/app", false);
    await ready(h, ["a"], { memAvailMb: 3000 });
    await ready(h, ["b"]);
    await ready(h, ["c"], { diskFreePct: 5 });
    h.sched.onHeartbeat(hb("a", { memAvailMb: 3000 }));
    const id = submit(h);
    const gpu = submit(h, { requires: ["gpu"] });
    const q = queue(h);
    expect(q.queued.find((t) => t.id === id)!.waiting).toBe("a: memory 3000 MB free, needs 2048+2048; b: doctor failed: missing tool; c: disk 5% free, floor 15%");
    expect(q.queued.find((t) => t.id === gpu)!.waiting).toMatch(/^a: lacks label gpu; b: lacks label gpu; c: lacks label gpu$/);
    h.sched.onHeartbeat(hb("a", { memAvailMb: 9000 }));
    expect(queue(h).queued.find((t) => t.id === id)!.waiting).toBeNull();
  });

  test("a usage-limit hold and an empty fleet are the reason", () => {
    const h = harness();
    const id = submit(h, { billing: "session" });
    expect(queue(h).queued[0].waiting).toBe("no host has reported");
    h.db.setMeta("hold_until", String(h.clock.t + 60_000));
    const q = queue(h);
    expect(q.holdUntil).toBe(h.clock.t + 60_000);
    expect(q.queued[0]).toMatchObject({ id, waiting: expect.stringMatching(/^usage-limit hold until /) });
  });

  test("follow-ups wait for the running turn, then for room on their host", async () => {
    const h = harness();
    await ready(h, ["a"], { maxThreads: 1 });
    const t1 = submit(h);
    await h.sched.tick();
    h.sched.send(t1, "more"); h.sched.send(t1, "and more");
    expect(queue(h).followUps).toEqual([expect.objectContaining({ id: t1, host: "a", count: 2, waiting: "current turn still running" })]);
    h.sched.onTurnEnd(turnEnd("a", t1, 1, 1));
    expect(queue(h).followUps[0].waiting).toBeNull();
    h.sched.onHeartbeat(hb("a", { maxThreads: 0 }));
    expect(queue(h).followUps[0].waiting).toBe("host a: full 0/0");
    h.sched.onHeartbeat(hb("a", { memAvailMb: 3000 }));
    expect(queue(h).followUps[0].waiting).toBe("host a: memory 3000 MB free, needs 2048+2048");
    await h.sched.tick();
    expect(h.db.thread(t1)!.state).toBe("idle");   // it does not start without room
    h.sched.onHeartbeat(hb("a"));
    await h.sched.tick();
    expect(h.db.thread(t1)!.state).toBe("running");
  });

  test("served over HTTP with the caller token, and printed by wd queue", async () => {
    const h = harness();
    await ready(h, ["a"], { maxThreads: 1 });
    const id = submit(h, { tag: "T" });
    await h.sched.tick();
    const q2 = submit(h);
    const handle = makeHandler(h.sched, h.reports);
    expect((await handle(new Request("http://x/queue", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    const body = await (await handle(new Request("http://x/queue", { headers: { authorization: "Bearer ct" } }))).json();
    expect(body.queued.map((t: any) => t.id)).toEqual([q2]);
    const text = queueText(body);
    expect(text).toContain(`queued (1)\n  ${q2}  o/app  -  orch:x`);
    expect(text).toContain("a: full 1/1");
    expect(text).toMatch(new RegExp(`  a  ok  1/1  cpu=0\\.0/8  mem=16000/32768MB  disk=50%\\n    ${id}  o/app  T  orch:x  turn 1  `));
  });

  test("what a click opens: each host's eligibility per repo, a follow-up's waiting text, a queued prompt, and idle threads", async () => {
    const h = harness();
    h.agent.doctorOk.set("b|o/app", false);
    await ready(h, ["a", "b"], { maxThreads: 1 });
    const t1 = submit(h, { tag: "one" });
    await h.sched.tick();
    const t2 = submit(h, { tag: "two" });
    await h.sched.tick();   // b fails o/app's doctor, a is full: t2 waits
    const t3 = submit(h, { repo: "o/rs", prompt: "p".repeat(600) });
    h.sched.send(t1, "and also this");
    let q = queue(h);
    expect(q.hosts.find((x) => x.name === "b")!.repos).toEqual({ "o/app": "doctor failed: missing tool", "o/rs": null });
    expect(q.hosts.find((x) => x.name === "a")!.repos).toEqual({ "o/app": "full 1/1", "o/rs": "full 1/1" });
    expect(q.followUps[0]).toMatchObject({ id: t1, texts: ["and also this"] });
    expect(q.queued.map((e) => [e.id, e.prompt.length])).toEqual([[t2, 5], [t3, 500]]);
    expect(q.idle).toEqual([]);
    await h.sched.tick();   // t3 starts on b; t1's follow-up waits for its running turn
    h.sched.onTurnEnd(turnEnd("a", t1, 1, 1));
    h.sched.onTurnEnd(turnEnd("b", t3, 1, 1, { result: { isError: false, text: "r".repeat(700), totalCostUsd: 1, durationMs: 1 } }));
    q = queue(h);
    expect(q.idle).toEqual([{ id: t3, caller: "orch:x", repo: "o/rs", tag: null, host: "b", since: h.clock.t, turns: 1, lastMessage: "r".repeat(600) }]);   // t1 has a follow-up waiting
    expect(queueText(q)).toContain(`idle (1)\n  ${t3}  b  -  1 turn  `);
  });
});
