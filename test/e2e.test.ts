// End to end: a real coordinator process, a real agent process (darwin/process-group mode on this Mac) running
// fake-claude against a local bare repo, driven through the HTTP API, the CLI and the MCP server over stdio.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Report, ThreadView } from "../src/shared/types";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src/main.ts");
const root = mkdtempSync(join(tmpdir(), "wd-e2e-"));
const origin = join(root, "origin.git"), dataDir = join(root, "agent-data"), dbFile = join(root, "wd.sqlite");
const TOKEN = "caller-tok", HOST_TOKEN = "host-tok", CALLER = "e2e:main";
const procs: Bun.Subprocess[] = [];
let coordUrl = "", agentPort = 0, agentCfg = "", agent: Bun.Subprocess;

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
const freePort = () => { const s = Bun.serve({ port: 0, fetch: () => new Response("") }); const p = s.port!; s.stop(true); return p; };
async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000, what = "condition"): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) { const v = await fn(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}
const api = async (method: string, path: string, body?: unknown, caller = CALLER) => {
  const r = await fetch(coordUrl + path.replace("{c}", encodeURIComponent(caller)), {
    method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const cli = async (env: Record<string, string>, ...args: string[]) => {
  const p = Bun.spawn([process.execPath, MAIN, ...args], { env: { ...process.env, WD_URL: coordUrl, WD_TOKEN: TOKEN, WD_CALLER: CALLER, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code: p.exitCode, out: out.trim(), err: err.trim() };
};
const reportsOf = async (thread: string, caller = CALLER): Promise<Report[]> => (await api("GET", "/reports?caller={c}", undefined, caller) as Report[]).filter((r) => r.thread === thread);
const view = (id: string): Promise<ThreadView> => api("GET", `/threads/${id}`);
const submit = (prompt: string, extra: object = {}): Promise<{ id: string }> => api("POST", "/threads", { caller: CALLER, repo: "o/r", prompt, ...extra });
const turnDir = (id: string) => join(dataDir, "turns", `${id}-1-1`);
const dbEvents = (id: string): string[] => {
  const d = new Database(dbFile, { readonly: true });
  try { return (d.query(`SELECT line FROM events WHERE thread=? AND turn=1 ORDER BY "offset"`).all(id) as { line: string }[]).flatMap((r) => JSON.parse(r.line) as string[]); } finally { d.close(); }
};
const startAgent = () => {
  const p = Bun.spawn([process.execPath, MAIN, "agent", "--config", agentCfg], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  procs.push(p);
  return p;
};
const branchHead = (b: string) => Bun.spawnSync(["git", "--git-dir", origin, "rev-parse", "--verify", "-q", `refs/heads/${b}`]).stdout.toString().trim();

beforeAll(async () => {
  sh(root, "git", "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  sh(root, "git", "clone", "-q", origin, seed);
  writeFileSync(join(seed, "README"), "seed\n");
  sh(seed, "git", "add", "README"); sh(seed, "git", "commit", "-qm", "seed"); sh(seed, "git", "push", "-q", "origin", "HEAD:main");

  const claude = join(root, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, "test/fake-claude.ts"))} "$@"\n`);
  chmodSync(claude, 0o755);

  const coordPort = freePort(); agentPort = freePort();
  coordUrl = `http://127.0.0.1:${coordPort}`;
  const coordCfg = join(root, "coord.json");
  writeFileSync(coordCfg, JSON.stringify({
    listen: `127.0.0.1:${coordPort}`, db: dbFile, callerToken: TOKEN, tickMs: 300,
    hosts: { h1: { url: `http://127.0.0.1:${agentPort}`, token: HOST_TOKEN } },
    repos: { "o/r": { url: origin, defaultRef: "main", requires: [] } },
    floors: { diskFreePct: 0, memReserveMb: 0, cpuOversub: 1000 },
  }));
  agentCfg = join(root, "agent.json");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(agentCfg, JSON.stringify({
    name: "h1", listen: `127.0.0.1:${agentPort}`, coordUrl, token: HOST_TOKEN, dataDir, claude,
    heartbeatSec: 1, tailMs: 100, labels: ["e2e-label"], maxThreads: 8, path: process.env.PATH,
  }));
  procs.push(Bun.spawn([process.execPath, MAIN, "coord"], { env: { ...process.env, WD_CONFIG: coordCfg }, stdout: "ignore", stderr: "ignore", stdin: "ignore" }));
  await until(async () => (await fetch(coordUrl + "/healthz").catch(() => null))?.ok, 15_000, "coordinator up");
  agent = startAgent();
  await until(async () => (await api("GET", "/hosts")).find((h: any) => h.name === "h1" && h.state === "ok"), 60_000, "host h1 ok");
}, 90_000);

afterAll(() => {
  for (const p of procs) try { p.kill("SIGKILL"); } catch {}
  Bun.spawnSync(["pkill", "-f", `${root}/`]);   // only turns started under this test's own temp dir
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

let commitId = "";

test("three threads each produce exactly one turn report with the right outcome", async () => {
  const out = await cli({}, "submit", "o/r", "COMMIT make a file", "--tag", "commit");
  expect(out.code).toBe(0);
  commitId = JSON.parse(out.out).id;
  // requires: placement only works if the agent sends its labels in heartbeats.
  const failId = (await submit("FAIL please", { tag: "fail", requires: ["e2e-label"] })).id;
  const sleepId = (await submit("SLEEP:3 wait", { tag: "sleep" })).id;

  for (const id of [commitId, failId, sleepId]) await until(async () => (await reportsOf(id)).length > 0, 40_000, `report for ${id}`);
  await Bun.sleep(1500);   // a duplicate report would have shown up by now

  const [c, f, s] = await Promise.all([commitId, failId, sleepId].map((i) => reportsOf(i)));
  expect([c.length, f.length, s.length]).toEqual([1, 1, 1]);

  expect(c[0]).toMatchObject({ kind: "turn", state: "idle", isError: false, pushed: true, tag: "commit", host: "h1", branch: `wd/${commitId}` });
  expect(c[0].head).toMatch(/^[0-9a-f]{40}$/);
  expect(branchHead(`wd/${commitId}`)).toBe(c[0].head!);
  expect(c[0].message).toContain("fake done");

  expect(f[0]).toMatchObject({ isError: true, pushed: false, tag: "fail" });
  expect(f[0].message).toContain("fake failure");
  expect(branchHead(`wd/${failId}`)).toBe("");

  expect(s[0]).toMatchObject({ kind: "turn", state: "idle", isError: false, pushed: false });
  expect(s[0].turnSeconds).toBeGreaterThanOrEqual(2);
  for (const r of [...c, ...f, ...s]) await api("POST", `/reports/${r.id}/ack`);
}, 90_000);

test("a follow-up on the idle thread resumes the same session and reports again", async () => {
  expect((await view(commitId)).state).toBe("idle");
  const sent = await cli({}, "send", commitId, "COMMIT", "again");
  expect(sent.code).toBe(0);
  const r2 = await until(async () => (await reportsOf(commitId))[0], 40_000, "second report");
  expect(r2).toMatchObject({ kind: "turn", state: "idle", isError: false, pushed: true });
  expect(r2.message).toContain("turn 2");   // fake-claude counts turns per session id, so --resume reached the same session
  const first = (await view(commitId));
  expect(first.turns).toBe(2);
  expect(branchHead(`wd/${commitId}`)).toBe(r2.head!);
  expect(first.costUsd).toBeCloseTo(0.04, 5);   // cumulative totals, recorded as differences
  expect(r2.turnCostUsd).toBeCloseTo(0.02, 5);
  await api("POST", `/reports/${r2.id}/ack`);
}, 60_000);

test("cancelling a running thread gives a final cancelled report", async () => {
  const id = (await submit("SLEEP:60 long")).id;
  await until(async () => (await view(id)).state === "running" && existsSync(join(turnDir(id), "out.jsonl")), 30_000, "running");
  await view(id);
  await api("POST", `/threads/${id}/cancel`);
  const r = await until(async () => (await reportsOf(id)).find((x) => x.kind === "final"), 30_000, "final report");
  expect(r.state).toBe("cancelled");
  expect((await reportsOf(id)).length).toBe(1);
  await api("POST", `/reports/${r.id}/ack`);
  await until(() => Bun.spawnSync(["pgrep", "-f", `${turnDir(id)}`]).stdout.toString().trim() === "", 15_000, "turn process gone");
}, 90_000);

test("restarting the agent mid-turn loses and repeats no events and the turn still reports", async () => {
  const id = (await submit("TICK:40 SLEEP:2 restart me")).id;
  await until(() => dbEvents(id).length >= 4, 30_000, "some events");
  agent.kill("SIGTERM");
  await agent.exited;
  const before = dbEvents(id).length;
  await Bun.sleep(1500);   // the turn keeps running detached while no agent is up
  agent = startAgent();
  const r = await until(async () => (await reportsOf(id))[0], 60_000, "report after restart");
  expect(r).toMatchObject({ kind: "turn", state: "idle", isError: false });
  await Bun.sleep(500);
  const file = readFileSync(join(turnDir(id), "out.jsonl"), "utf8").split("\n").filter(Boolean);
  const got = dbEvents(id);
  expect(got.length).toBeGreaterThan(before);
  expect(got).toEqual(file.map((l) => (l.length > 8000 ? l.slice(0, 8000) : l)));
  expect((await reportsOf(id)).length).toBe(1);
  await api("POST", `/reports/${r.id}/ack`);
}, 120_000);

test("a turn whose process vanished with the host (no exit file) is resumed as turn 2 after the agent restarts", async () => {
  const id = (await submit("SLEEP:60 vanish")).id;
  await until(async () => (await view(id)).state === "running" && existsSync(join(turnDir(id), "pid")), 30_000, "running");
  const pgid = Number(readFileSync(join(turnDir(id), "pid"), "utf8"));   // run.sh leads its own process group
  // Like a reboot: the agent is down, then everything of the turn dies at once, run.sh included, so no exit file is written.
  agent.kill("SIGTERM");
  await agent.exited;
  process.kill(-pgid, "SIGKILL");
  expect(existsSync(join(turnDir(id), "exit"))).toBe(false);
  agent = startAgent();
  const rs = await until(async () => { const r = await reportsOf(id); return r.length >= 2 && r; }, 60_000, "two reports");
  expect(rs[0]).toMatchObject({ kind: "turn", reason: "host-restart: resuming", isError: false, host: "h1" });
  expect(rs[1]).toMatchObject({ kind: "turn", state: "idle", isError: false, reason: null, host: "h1" });
  expect(rs[1].message).toContain("turn 2");    // the same session, resumed
  const v = await view(id);
  expect(v).toMatchObject({ state: "idle", turns: 2, epoch: 2 });
  expect(readFileSync(join(dataDir, "turns", `${id}-2-2`, "prompt.txt"), "utf8")).toBe("You were interrupted by a host restart. Continue where you left off.");
  expect(readFileSync(join(dataDir, "turns", `${id}-2-2`, "run.sh"), "utf8")).toContain("'--resume'");
  await Bun.sleep(1000);
  expect((await reportsOf(id)).length).toBe(2);   // no further turn
  for (const r of rs) await api("POST", `/reports/${r.id}/ack`);
}, 120_000);

test("the MCP server turns a new report into a channel notification; wd_ack acks it", async () => {
  const caller = "e2e:mcp";
  const client = new Client({ name: "e2e", version: "0" });
  const events: any[] = [];
  client.fallbackNotificationHandler = async (n) => { if (n.method === "notifications/claude/channel") events.push(n.params); };
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [MAIN, "mcp"],
    env: { ...process.env, WD_URL: coordUrl, WD_TOKEN: TOKEN, WD_CALLER: caller } as Record<string, string>,
  }));
  try {
    expect(client.getServerCapabilities()?.experimental).toHaveProperty("claude/channel");
    const sub: any = await client.callTool({ name: "wd_submit", arguments: { repo: "o/r", prompt: "COMMIT via mcp", tag: "m" } });
    const id = JSON.parse(sub.content[0].text).id as string;
    const ev = await until(() => events.find((e) => e.meta?.thread === id), 40_000, "channel notification");
    expect(ev.meta).toMatchObject({ thread: id, state: "idle", kind: "turn", tag: "m" });
    expect(String(ev.content)).toContain(id);
    expect((await reportsOf(id, caller)).length).toBe(1);      // pushing alone never acks
    await client.callTool({ name: "wd_ack", arguments: { id: Number(ev.meta.report) } });
    await until(async () => (await reportsOf(id, caller)).length === 0, 10_000, "report acked");
    expect(events.filter((e) => e.meta?.thread === id).length).toBe(1);
  } finally { await client.close(); }
}, 90_000);

test("the CLI lists hosts and threads", async () => {
  const h = await cli({}, "hosts");
  expect(h.code).toBe(0);
  expect(h.out).toContain("h1\tok");
  const l = await cli({}, "ls", "--all");
  expect(l.out).toContain(commitId);
  expect((await cli({ WD_TOKEN: "wrong" }, "hosts")).code).toBe(1);
});
