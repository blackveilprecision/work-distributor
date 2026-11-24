import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, streamReports } from "../../src/mcp/server.ts";
import { fakeCoord, rep, until } from "./fake-coord.ts";

let stops: (() => void)[] = [];
afterEach(() => { stops.forEach((f) => f()); stops = []; });

async function setup(opts: { drop?: boolean } = {}) {
  const coord = fakeCoord();
  if (opts.drop) coord.dropFirstStream();
  const cfg = { url: coord.url, token: coord.token, caller: "t:x" };
  const { server, refresh } = createServer(cfg);
  const client = new Client({ name: "test", version: "0" });
  const events: any[] = [];
  client.fallbackNotificationHandler = async (n) => { events.push(n); };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const ctl = new AbortController();
  stops.push(() => { ctl.abort(); coord.stop(); });
  return { coord, cfg, server, refresh, client, events, ctl };
}

test("declares the channel capability and the eight tools", async () => {
  const { client } = await setup();
  expect(client.getServerCapabilities()?.experimental).toHaveProperty("claude/channel");
  expect(client.getInstructions()).toContain("channel");
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(["wd_ack", "wd_cancel", "wd_hosts", "wd_inbox", "wd_release", "wd_send", "wd_status", "wd_submit"]);
});

test("tools call the coordinator and return at once", async () => {
  const { client, coord } = await setup();
  const r: any = await client.callTool({ name: "wd_submit", arguments: { repo: "o/r", prompt: "do it", tag: "a" } });
  expect(JSON.parse(r.content[0].text)).toEqual({ id: "th1", position: 0 });
  expect(coord.reqs.at(-2)).toMatchObject({ method: "POST", path: "/mcp/call", body: { name: "wd_submit", caller: "t:x" } });
  const post = coord.reqs.find((q) => q.method === "POST" && q.path === "/threads")!;
  expect(post.body).toMatchObject({ caller: "t:x", repo: "o/r", prompt: "do it", tag: "a" });
  expect(post.auth).toBe("Bearer tok");

  await client.callTool({ name: "wd_send", arguments: { thread: "th1", text: "more" } });
  expect(coord.reqs.at(-1)).toMatchObject({ method: "POST", path: "/threads/th1/send", body: { text: "more" } });
  await client.callTool({ name: "wd_cancel", arguments: { thread: "th1" } });
  expect(coord.reqs.at(-1)!.path).toBe("/threads/th1/cancel");
  await client.callTool({ name: "wd_release", arguments: { thread: "th1" } });
  expect(coord.reqs.at(-1)!.path).toBe("/threads/th1/release");
  const ls: any = await client.callTool({ name: "wd_status", arguments: {} });
  expect(coord.reqs.at(-1)!.path).toBe("/threads?caller=t%3Ax");
  const list = JSON.parse(ls.content[0].text);
  expect(list.threads).toHaveLength(50);
  expect(list.more).toBe(10);
  expect(list.threads[0]).toEqual({ id: "t0", tag: null, state: "done", host: "box1", turns: 1, reason: null });
  await client.callTool({ name: "wd_status", arguments: { thread: "th1" } });
  expect(coord.reqs.at(-1)!.path).toBe("/threads/th1");
  await client.callTool({ name: "wd_hosts", arguments: {} });
  expect(coord.reqs.at(-1)!.path).toBe("/hosts");
  coord.pending.push(rep(5));
  const inbox: any = await client.callTool({ name: "wd_inbox", arguments: {} });
  expect(JSON.parse(inbox.content[0].text)[0].id).toBe(5);
  await client.callTool({ name: "wd_ack", arguments: { id: 5 } });
  expect(coord.acked).toEqual([5]);
});

test("a coordinator error becomes a tool error", async () => {
  const { client, cfg } = await setup();
  cfg.token = "wrong";
  const r: any = await client.callTool({ name: "wd_hosts", arguments: {} });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("401");
});

test("stream: unacked then live reports become channel events; pushing never acks", async () => {
  const { coord, cfg, server, events, ctl } = await setup();
  coord.pending.push(rep(1, { state: "failed", isError: true, reason: "oom", kind: "final" }));
  void streamReports(cfg, server, ctl.signal, 20, 100);
  await until(() => events.length === 1);
  const n = events[0];
  expect(n.method).toBe("notifications/claude/channel");
  expect(n.params.meta).toEqual({ report: "1", thread: "th1", state: "failed", kind: "final", tag: "job" });
  expect(n.params.content).toContain("call wd_ack");
  expect(n.params.content).toContain("reason: oom");
  expect(n.params.content).toContain("thread th1");

  coord.push(rep(2, { kind: "turn", state: "idle", tag: null }));
  await until(() => events.length === 2);
  expect(events[1].params.meta).toEqual({ report: "2", thread: "th2", state: "idle", kind: "turn", tag: "" });
  // A channel event can be dropped silently by Claude Code, so only wd_ack or the hook may ack.
  expect(coord.acked).toEqual([]);
  expect(coord.reqs.some((q) => q.path === "/reports/stream?caller=t%3Ax")).toBe(true);
});

test("stream: reconnects with backoff after the connection drops, without duplicating", async () => {
  const { coord, cfg, server, events, ctl } = await setup({ drop: true });
  coord.pending.push(rep(7));
  void streamReports(cfg, server, ctl.signal, 20, 100);
  await until(() => events.length === 1 && coord.reqs.filter((q) => q.path.startsWith("/reports/stream")).length >= 2);
  coord.push(rep(8));
  await until(() => events.length === 2);
  expect(events.map((e) => e.params.meta.thread)).toEqual(["th7", "th8"]);
});

test("tools come from the coordinator; a changed list on reconnect sends tools/list_changed", async () => {
  const { coord, cfg, server, refresh, client, events, ctl } = await setup();
  expect((await client.listTools()).tools.length).toBe(8);
  void streamReports(cfg, server, ctl.signal, 20, 100, refresh);   // what wd mcp wires up
  await until(() => coord.reqs.some((q) => q.path.startsWith("/reports/stream")));
  await Bun.sleep(50);
  expect(events.filter((e) => e.method === "notifications/tools/list_changed")).toEqual([]);   // unchanged: no notice
  coord.tools.list = [...coord.tools.list, { name: "wd_new", description: "x", inputSchema: { type: "object", properties: {} } }];
  await refresh();
  expect(events.filter((e) => e.method === "notifications/tools/list_changed")).toHaveLength(1);
  expect((await client.listTools()).tools.map((t) => t.name)).toContain("wd_new");
});
