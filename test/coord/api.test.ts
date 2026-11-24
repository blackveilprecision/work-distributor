import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { makeHandler } from "../../src/coord/api";
import { httpAgent } from "../../src/coord/scheduler";
import { loadConfig } from "../../src/coord/config";
import { harness, hb, ready, turnEnd } from "./helpers";
import { reportText } from "../../src/cli/client";

function api() {
  const h = harness();
  const handle = makeHandler(h.sched, h.reports);
  const call = async (method: string, path: string, body?: unknown, token = "ct") => {
    const r = await handle(new Request("http://x" + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  return { h, handle, call };
}

describe("auth", () => {
  test("caller routes need the caller token; agent routes need that host's token and the right host name", async () => {
    const { call } = api();
    expect((await call("GET", "/hosts", undefined, "nope")).status).toBe(401);
    expect((await call("GET", "/hosts")).status).toBe(200);
    expect((await call("POST", "/agent/heartbeat", hb("a"), "ct")).status).toBe(401);
    expect((await call("POST", "/agent/heartbeat", hb("a"), "tb")).status).toBe(401);   // b's token, claiming a
    expect((await call("POST", "/agent/heartbeat", hb("zzz"), "ta")).status).toBe(401);
    expect((await call("POST", "/agent/heartbeat", hb("a"), "ta")).body).toEqual({ stop: [], version: expect.any(String) });
    expect((await call("GET", "/healthz", undefined, "")).status).toBe(200);
  });
});

describe("round trip over HTTP", () => {
  test("submit -> place -> events -> turn-end -> report -> ack -> send -> release", async () => {
    const { h, call } = api();
    await ready(h, ["a"]);
    const bad = await call("POST", "/threads", { caller: "orch:x", repo: "nope", prompt: "p" });
    expect(bad.status).toBe(400);
    const sub = await call("POST", "/threads", { caller: "orch:x", repo: "o/app", prompt: "p", tag: "T" });
    expect(sub.status).toBe(201);
    expect(sub.body.position).toBe(1);
    const id = sub.body.id;
    await h.sched.tick();
    expect((await call("GET", `/threads/${id}`)).body).toMatchObject({ state: "running", host: "a", epoch: 1, tag: "T" });
    expect((await call("GET", "/threads?caller=other")).body).toEqual([]);
    expect((await call("GET", "/threads?caller=orch:x")).body).toHaveLength(1);

    const ev = { host: "a", thread: id, epoch: 1, turn: 1, offset: 0, lines: ["{}"], nextOffset: 3 };
    expect((await call("POST", "/agent/events", ev, "ta")).body).toEqual({ committed: 3 });
    expect((await call("POST", "/agent/events", { ...ev, epoch: 9 }, "ta")).status).toBe(409);
    expect((await call("POST", "/agent/turn-end", turnEnd("a", id, 1, 1), "ta")).status).toBe(200);
    expect((await call("POST", "/agent/turn-end", turnEnd("a", id, 7, 1), "ta")).status).toBe(409);

    const reps = (await call("GET", "/reports?caller=orch:x")).body;
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ thread: id, tag: "T", kind: "turn", state: "idle", message: "done", head: "abc123", host: "a" });
    expect((await call("POST", `/reports/${reps[0].id}/ack`)).body).toEqual({ ok: true });
    expect((await call("GET", "/reports?caller=orch:x")).body).toEqual([]);

    expect((await call("POST", `/threads/${id}/send`, { text: "go on" })).status).toBe(202);
    expect((await call("POST", `/threads/${id}/send`, {})).status).toBe(400);
    expect((await call("POST", `/threads/${id}/release`)).body.state).toBe("done");
    expect((await call("GET", "/hosts")).body[0]).toMatchObject({ name: "a", state: "ok", running: 0 });
    expect((await call("GET", "/threads/missing")).status).toBe(404);
  });

  test("hosts view lists configured hosts never seen as lost", async () => {
    const { call } = api();
    const hosts = (await call("GET", "/hosts")).body;
    expect(hosts.map((x: any) => [x.name, x.state])).toEqual([["a", "lost"], ["b", "lost"], ["c", "lost"]]);
  });
});

describe("reports delivery", () => {
  test("SSE sends the unacked backlog, then new reports, and not acked ones", async () => {
    const { h, handle, call } = api();
    await ready(h, ["a"]);
    const t1 = (await call("POST", "/threads", { caller: "c1", repo: "o/app", prompt: "p" })).body.id;
    const t2 = (await call("POST", "/threads", { caller: "c1", repo: "o/app", prompt: "p" })).body.id;
    await h.sched.tick();
    h.sched.onTurnEnd(turnEnd("a", t1, 1, 1));
    const first = h.reports.pending("c1")[0];
    const res = await handle(new Request("http://x/reports/stream?caller=c1", { headers: { authorization: "Bearer ct" } }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader(), dec = new TextDecoder();
    const next = async () => { const { value } = await reader.read(); return dec.decode(value); };
    const a = await next();
    expect(a).toContain(`id: ${first.id}`);
    h.sched.onTurnEnd(turnEnd("a", t2, 1, 1));
    const b = await next();
    expect(JSON.parse(b.split("data: ")[1].trim())).toMatchObject({ thread: t2, kind: "turn" });
    await reader.cancel();
  });

  test("webhook: 2xx acks; a failure is retried with backoff and never dropped", async () => {
    const { h, call } = api();
    await ready(h, ["a"]);
    await call("PUT", "/callers/svc", { webhook: "http://svc/hook" });
    const id = (await call("POST", "/threads", { caller: "svc", repo: "o/app", prompt: "p" })).body.id;
    await h.sched.tick();
    h.hook.ok = false;
    h.sched.onTurnEnd(turnEnd("a", id, 1, 1));
    await Bun.sleep(5);
    expect(h.posted).toHaveLength(1);
    expect(h.reports.pending("svc")).toHaveLength(1);
    await h.reports.retry();                          // too early: backoff
    expect(h.posted).toHaveLength(1);
    h.advance(5_001); h.hook.ok = false; await h.reports.retry();
    expect(h.posted).toHaveLength(2);
    h.advance(10_001); await h.reports.retry();       // doubled backoff has not passed at 5 s, passes at 10 s
    expect(h.posted).toHaveLength(3);
    h.advance(20_001); h.hook.ok = true; await h.reports.retry();
    expect(h.posted).toHaveLength(4);
    expect(h.posted[3].body).toMatchObject({ thread: id, kind: "turn" });
    expect(h.reports.pending("svc")).toHaveLength(0);
  });

  test("reports survive a reopen of the database file (durable until acked)", async () => {
    const { Db } = await import("../../src/coord/db");
    const { Reports } = await import("../../src/coord/reports");
    const path = join(tmpdir(), `wd-coord-test-${Date.now()}.sqlite`);
    const db = new Db(path);
    db.run("INSERT INTO threads(id,caller,repo,ref,branch,state,created,updated) VALUES('t','c','r','m','b','idle',1,1)");
    new Reports(db).add("t", "turn", { message: "hi" });
    db.raw.close();
    expect(new Reports(new Db(path)).pending("c")[0].message).toBe("hi");
  });
});

describe("config", () => {
  test("WD_CONFIG is read, tilde paths are expanded, defaults filled in", () => {
    const p = join(tmpdir(), `wd-coord-cfg-${Date.now()}.json`);
    writeFileSync(p, JSON.stringify({ callerToken: "x", db: "~/wd-test.sqlite", repos: { "o/r": { url: "u" } } }));
    const prev = process.env.WD_CONFIG;
    process.env.WD_CONFIG = p;
    try {
      const c = loadConfig();
      expect(c.db).toBe(homedir() + "/wd-test.sqlite");
      expect(c).toMatchObject({ listen: "127.0.0.1:7780", tickMs: 5000, stallMin: 20, lostAfterSec: 120, floors: { diskFreePct: 15, memReserveMb: 2048 } });
      expect(c.repos["o/r"]).toMatchObject({ defaultRef: "main", requires: [], rust: false });
    } finally { if (prev === undefined) delete process.env.WD_CONFIG; else process.env.WD_CONFIG = prev; }
    expect(() => loadConfig(p.replace(".json", "-missing.json"))).toThrow();
  });
});

describe("hosts and repos registered at runtime", () => {
  const enc = encodeURIComponent;

  test("repos: PUT with a slash in the id, defaults, GET, DELETE; validation and auth", async () => {
    const { call } = api();
    const put = await call("PUT", `/repos/${enc("acme/shop")}`, { url: "https://github.com/acme/shop.git" });
    expect(put).toMatchObject({ status: 200, body: { id: "acme/shop", defaultRef: "main", requires: [], rust: false, source: "db" } });
    await call("PUT", "/repos/acme/api", { url: "u", defaultRef: "dev", doctor: "true", requires: ["gpu"], rust: true });   // an unencoded slash works too
    const list = (await call("GET", "/repos")).body as any[];
    expect(list.map((r) => r.id).sort()).toEqual(["acme/api", "acme/shop", "o/app", "o/rs"]);
    expect(list.find((r) => r.id === "acme/api")).toMatchObject({ url: "u", defaultRef: "dev", doctor: "true", requires: ["gpu"], rust: true, source: "db" });
    expect(list.find((r) => r.id === "o/app").source).toBe("config");
    expect((await call("PUT", "/repos/acme%2Fshop", { url: "https://other" })).body.url).toBe("https://other");   // PUT replaces
    expect((await call("DELETE", `/repos/${enc("acme/shop")}`)).status).toBe(200);
    expect((await call("DELETE", `/repos/${enc("acme/shop")}`)).status).toBe(404);
    expect((await call("PUT", "/repos/acme%2Fx", {})).status).toBe(400);
    expect((await call("PUT", "/repos/..%2Fx", { url: "u" })).status).toBe(400);
    expect((await call("GET", "/repos", undefined, "nope")).status).toBe(401);
    expect((await call("PUT", "/repos/a%2Fb", { url: "u" }, "ta")).status).toBe(401);   // a host token is not a caller token
  });

  test("a repo registered while the coordinator runs can be submitted to and is placed with its doctor; config wins a clash", async () => {
    const { h, call } = api();
    await ready(h, ["a"]);
    expect((await call("POST", "/threads", { caller: "c", repo: "new/repo", prompt: "p" })).status).toBe(400);
    await call("PUT", "/repos/new%2Frepo", { url: "git@x:new/repo.git", defaultRef: "dev", doctor: "true", requires: ["gpu"] });
    const id = (await call("POST", "/threads", { caller: "c", repo: "new/repo", prompt: "p" })).body.id;
    expect((await call("GET", `/threads/${id}`)).body.ref).toBe("dev");
    await h.sched.tick(); await h.sched.idle();
    expect(h.agent.doctored.map((d) => d.b.repoId)).toContain("new/repo");
    expect((await call("GET", `/threads/${id}`)).body.state).toBe("queued");   // host a has no "gpu" label
    // coord.json wins
    const clash = await call("PUT", "/repos/o%2Fapp", { url: "git@evil:o/app.git" });
    expect(clash.body).toMatchObject({ url: "git@x:o/app.git", source: "config" });
    expect(((await call("GET", "/repos")).body as any[]).find((r) => r.id === "o/app").url).toBe("git@x:o/app.git");
    expect((await call("DELETE", "/repos/o%2Fapp")).status).toBe(409);
  });

  test("a thread whose repo was removed fails instead of breaking the scheduler", async () => {
    const { h, call } = api();
    await ready(h, ["a"]);
    await call("PUT", "/repos/gone%2Frepo", { url: "u" });
    const id = (await call("POST", "/threads", { caller: "c", repo: "gone/repo", prompt: "p" })).body.id;
    await call("DELETE", "/repos/gone%2Frepo");
    await h.sched.tick();
    expect((await call("GET", `/threads/${id}`)).body).toMatchObject({ state: "failed", reason: expect.stringContaining("no longer configured") });
  });

  test("hosts: PUT returns a token, re-PUT keeps it, rotate replaces it; the new token authenticates at once", async () => {
    const { h, call } = api();
    const first = (await call("PUT", "/hosts/box1", { url: "http://100.64.0.5:7781" })).body;
    expect(first).toMatchObject({ name: "box1", url: "http://100.64.0.5:7781", source: "db" });
    expect(first.token).toMatch(/^[0-9a-f]{48}$/);
    const again = (await call("PUT", "/hosts/box1", { url: "http://100.64.0.6:7781" })).body;   // keeps the token but never reveals it
    expect(again).toEqual({ name: "box1", url: "http://100.64.0.6:7781", source: "db" });
    expect((await call("POST", "/agent/heartbeat", hb("box1"), first.token)).status).toBe(200);
    const rotated = (await call("PUT", "/hosts/box1", { url: "http://100.64.0.6:7781", rotate: true })).body;
    expect(rotated.token).not.toBe(first.token);
    expect((await call("POST", "/agent/heartbeat", hb("box1"), first.token)).status).toBe(401);
    expect((await call("POST", "/agent/heartbeat", hb("box1"), rotated.token)).status).toBe(200);
    expect((await call("GET", "/hosts")).body.find((x: any) => x.name === "box1")).toMatchObject({ state: "ok" });
    expect(JSON.stringify((await call("PUT", "/hosts/a", { url: "http://other:1", rotate: true })).body)).not.toContain("ta\"");   // coord.json host: no token even with rotate
    expect((await call("PUT", "/hosts/x", { url: "nope" })).status).toBe(400);
    expect((await call("PUT", "/hosts/a%2Fb", { url: "http://x:1" })).status).toBe(400);
    // placement and the agent client see the registered host without a restart
    await h.sched.tick(); await h.sched.idle();
    const id = (await call("POST", "/threads", { caller: "c", repo: "o/app", prompt: "p" })).body.id;
    await h.sched.tick();
    expect((await call("GET", `/threads/${id}`)).body.host).toBe("box1");
    const sent: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: any, init: any) => { sent.push(`${u} ${init.headers.authorization}`); return Response.json({}); }) as any;
    try { await httpAgent((n) => h.sched.hostCfg(n)).stop("box1", { thread: "t", epoch: 1 }); } finally { globalThis.fetch = real; }
    expect(sent).toEqual([`http://100.64.0.6:7781/stop Bearer ${rotated.token}`]);
  });

  test("hosts: coord.json wins a clash; DELETE refuses config hosts and busy hosts, otherwise removes the host", async () => {
    const { h, call } = api();
    expect((await call("PUT", "/hosts/a", { url: "http://other:1" })).body).toEqual({ name: "a", url: "http://a", source: "config" });
    expect((await call("DELETE", "/hosts/a")).status).toBe(409);
    expect((await call("DELETE", "/hosts/nope")).status).toBe(404);
    const t = (await call("PUT", "/hosts/box2", { url: "http://100.64.0.7:7781" })).body.token;
    await ready(h, ["box2"]);
    const id = (await call("POST", "/threads", { caller: "c", repo: "o/app", prompt: "p" })).body.id;
    await h.sched.tick();
    expect((await call("DELETE", "/hosts/box2")).status).toBe(409);   // a turn is running on it
    h.sched.onTurnEnd(turnEnd("box2", id, 1, 1));
    await call("POST", `/threads/${id}/release`);
    expect((await call("DELETE", "/hosts/box2")).status).toBe(200);
    expect((await call("POST", "/agent/heartbeat", hb("box2"), t)).status).toBe(401);
    expect(((await call("GET", "/hosts")).body as any[]).some((x) => x.name === "box2")).toBe(false);
  });
});

describe("why a host gets no threads of a repo, and the whole of a long message", () => {
  test("GET /hosts lists failing doctors; ?repo= says per host why a thread of that repo could not start there now", async () => {
    const { h, call } = api();
    h.agent.doctorOk.set("b|o/app", false);
    await ready(h, ["a", "b"]);
    await ready(h, ["c"], { labels: ["gpu"], memAvailMb: 1000 });
    const all = (await call("GET", "/hosts")).body;
    expect(all.find((x: any) => x.name === "b")).toMatchObject({ state: "ok", doctorFailed: ["o/app"] });
    expect(all.find((x: any) => x.name === "a")).toMatchObject({ doctorFailed: [] });
    expect(all[0].why).toBeUndefined();
    const by = Object.fromEntries((await call("GET", "/hosts?repo=o%2Fapp")).body.map((x: any) => [x.name, x.why]));
    expect(by).toEqual({ a: null, b: "doctor failed: missing tool", c: "memory 1000 MB free, needs 2048+2048" });
    expect((await call("GET", "/hosts?repo=nope")).status).toBe(404);
  });

  test("a message over 4000 chars is cut in the report and in lastMessage, marked, and whole with ?full=1", async () => {
    const { h, call } = api();
    await ready(h, ["a"]);
    const id = (await call("POST", "/threads", { caller: "orch:x", repo: "o/app", prompt: "p" })).body.id;
    await h.sched.tick();
    const text = "x".repeat(4500) + "THE END";
    await call("POST", "/agent/turn-end", turnEnd("a", id, 1, 1, { result: { isError: false, text, totalCostUsd: 1, durationMs: 1 } }), "ta");
    const [r] = (await call("GET", "/reports?caller=orch:x")).body;
    expect(r).toMatchObject({ truncated: true });
    expect(r.message).toHaveLength(4000);
    expect((await call("GET", `/threads/${id}`)).body.lastMessage).toHaveLength(4000);
    expect((await call("GET", `/threads/${id}?full=1`)).body.lastMessage).toBe(text);
    expect(reportText(r)).toContain(`[message cut at 4000 chars: \`wd status ${id} --full\``);
    await call("POST", "/agent/turn-end", turnEnd("a", id, 1, 1), "ta");   // a repeat changes nothing
    await call("POST", `/threads/${id}/send`, { text: "more" });
    await h.sched.tick();
    await call("POST", "/agent/turn-end", turnEnd("a", id, 2, 2), "ta");
    expect((await call("GET", "/reports?caller=orch:x")).body[1]).toMatchObject({ truncated: false, message: "done" });
    expect((await call("GET", `/threads/${id}?full=1`)).body).toMatchObject({ lastMessage: "done", messages: [{ turn: 1, text }, { turn: 2, text: "done" }] });
  });
});

describe("mcp tools", () => {
  test("the tool list and calls are served by the coordinator", async () => {
    const { call } = api();
    const tools = (await call("GET", "/mcp/tools")).body;
    expect(tools.tools.map((t: any) => t.name)).toContain("wd_status");
    expect((await call("POST", "/mcp/call", { name: "wd_hosts", arguments: {} })).status).toBe(400);   // no caller
    expect((await call("POST", "/mcp/call", { name: "wd_nope", arguments: {}, caller: "c" })).status).toBe(404);
    const sub = await call("POST", "/mcp/call", { name: "wd_submit", arguments: { repo: "o/app", prompt: "p".repeat(5000) }, caller: "c" });
    expect(sub.status).toBe(200);
    const ls = (await call("POST", "/mcp/call", { name: "wd_status", arguments: {}, caller: "c" })).body;
    expect(ls).toEqual({ threads: [{ id: sub.body.id, tag: null, state: "queued", host: null, turns: 0, reason: null }], more: 0, note: expect.any(String) });
    expect((await call("POST", "/mcp/call", { name: "wd_status", arguments: { thread: "zz" }, caller: "c" })).status).toBe(404);
  });
});
