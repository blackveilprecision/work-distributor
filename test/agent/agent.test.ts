import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, sh, until } from "./harness";
import { sweepOrphans } from "../../src/agent/sweep";

setDefaultTimeout(45_000);
type H = Awaited<ReturnType<typeof harness>>;
let h: H;
afterEach(async () => { await h?.cleanup(); });
const alive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const key = (t: { thread: string; epoch: number; turn: number }) => `${t.thread}-${t.epoch}-${t.turn}`;
const endOf = (thread = "t1", turn = 1) => until(() => h.coord.ends(thread).find((e) => e.turn === turn), 20_000, `turn-end ${thread}/${turn}`);

describe("a turn", () => {
  beforeEach(async () => { h = await harness(); });

  test("runs, streams every line exactly once, pushes the branch and reports the result", async () => {
    const t = h.turn({ prompt: "COMMIT do the thing" });
    expect((await h.call("/start", t)).body.ok).toBe(true);
    const end = await endOf();
    expect(end).toMatchObject({ kind: "exited", exitCode: 0, pushed: true, pushError: null });
    expect(end.result).toMatchObject({ isError: false, text: "fake done (turn 1)", totalCostUsd: 0.02 });
    expect(end.result!.durationMs).toBeGreaterThanOrEqual(0);
    // the branch on origin is exactly what the worktree head was
    expect(h.originHead("wd/t1")).toBe(end.head!);
    expect(sh(h.origin, "git", "log", "-1", "--format=%s", "wd/t1")).toBe("fake commit fake-1.txt");

    const lines = h.coord.lines.get(key(t))!;
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["system", "assistant", "result"]);
    const out = join(h.turnDir(t), "out.jsonl");
    expect(h.coord.committed.get(key(t))).toBe(statSync(out).size);
    expect(readFileSync(join(h.turnDir(t), "offset"), "utf8")).toBe(String(statSync(out).size));
    expect(existsSync(join(h.turnDir(t), "ended"))).toBe(true);
    expect(end.memPeakMb).toBeGreaterThanOrEqual(0);
  });

  test("the session gets a clean environment and the documented flags, never a push credential", async () => {
    process.env.GH_TOKEN = "secret-gh";
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    try {
      const t = h.turn({ prompt: "x", model: "sonnet", rust: true });
      await h.call("/start", t);
      await endOf();
    } finally { delete process.env.GH_TOKEN; delete process.env.SSH_AUTH_SOCK; }
    const run = readFileSync(join(h.turnDir(h.turn()), "run.sh"), "utf8");
    expect(run).toContain("env -i");
    for (const bad of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "secret-gh"]) expect(run).not.toContain(bad);
    for (const good of ["DISABLE_AUTOUPDATER=1", "WD_THREAD=t1", "WD_KEY=t1-1", "CARGO_TARGET_DIR=", "--setting-sources", "--strict-mcp-config", "--dangerously-skip-permissions", "crossSessionInbound", "'--model' 'sonnet'", "--session-id"]) expect(run).toContain(good);
    expect(run).toContain(`TMPDIR=${join(h.cfg.dataDir, "wt/t1/.wd-tmp")}`);
  });

  test("send: a later turn resumes the same session in the same worktree, cost is cumulative, push is a lease update", async () => {
    const sessionId = crypto.randomUUID();
    await h.call("/start", h.turn({ sessionId, prompt: "COMMIT first" }));
    const first = await endOf("t1", 1);
    await h.call("/start", h.turn({ sessionId, turn: 2, resume: true, prompt: "COMMIT second" }));
    const second = await endOf("t1", 2);
    expect(second.result).toMatchObject({ isError: false, totalCostUsd: 0.04 });   // cumulative; the coordinator stores the difference
    expect(second.head).not.toBe(first.head);
    expect(second.pushed).toBe(true);
    expect(h.originHead("wd/t1")).toBe(second.head!);
    expect(sh(h.origin, "git", "rev-list", "--count", "main..wd/t1")).toBe("2");
    expect(readFileSync(join(h.turnDir(h.turn({ turn: 2 })), "run.sh"), "utf8")).toContain(`'--resume' '${sessionId}'`);
  });

  test("a resume of a worktree that is gone is rejected, not silently started fresh", async () => {
    const r = await h.call("/start", h.turn({ resume: true }));
    expect(r.status).toBe(500);
    expect(r.body.error).toContain("cannot resume");
  });

  test("is_error from claude is reported with its text and exit code", async () => {
    await h.call("/start", h.turn({ prompt: "FAIL" }));
    const end = await endOf();
    expect(end).toMatchObject({ kind: "exited", exitCode: 1, pushed: false });
    expect(end.result).toMatchObject({ isError: true, text: "fake failure" });
  });

  test("leftover changes are committed with the documented message and pushed; .wd-tmp is not", async () => {
    await h.call("/start", h.turn({ prompt: "DIRTY" }));
    const end = await endOf();
    expect(end.pushed).toBe(true);
    expect(sh(h.origin, "git", "log", "-1", "--format=%s", "wd/t1")).toBe("wd: uncommitted work at end of turn");
    const files = sh(h.origin, "git", "ls-tree", "-r", "--name-only", "wd/t1");
    expect(files).toContain("dirty.txt");
    expect(files).not.toContain(".wd-tmp");
  });

  test("a turn with no commits ahead of ref pushes nothing", async () => {
    await h.call("/start", h.turn({ prompt: "just talk" }));
    const end = await endOf();
    expect(end).toMatchObject({ pushed: false, pushError: null });
    expect(h.originHead("wd/t1")).toBeNull();
  });

  test("a 10 MB line is read whole, sent truncated to 8000 chars, and does not stop anything", async () => {
    const t = h.turn({ prompt: "BIGLINE COMMIT" });
    await h.call("/start", t);
    const end = await endOf();
    expect(end.result!.isError).toBe(false);
    const lines = h.coord.lines.get(key(t))!;
    expect(Math.max(...lines.map((l) => l.length))).toBe(8000);
    expect(lines.length).toBe(4);
    expect(h.coord.committed.get(key(t))).toBe(statSync(join(h.turnDir(t), "out.jsonl")).size);
    expect(statSync(join(h.turnDir(t), "out.jsonl")).size).toBeGreaterThan(10 * 1024 * 1024);
  });

  test("a duplicate /start of the same turn does not start it twice", async () => {
    const t = h.turn({ prompt: "COMMIT" });
    await Promise.all([h.call("/start", t), h.call("/start", t)]);
    await endOf();
    await h.call("/start", t);
    await Bun.sleep(300);
    expect(h.coord.ends("t1").length).toBe(1);
    expect(h.coord.lines.get(key(t))!.filter((l) => l.includes('"type":"result"')).length).toBe(1);
  });

  test("bad requests and bad tokens are refused", async () => {
    expect((await h.call("/start", { thread: "x" })).status).toBe(400);
    const r = await fetch(`http://127.0.0.1:${h.agent.port}/probe`, { headers: { authorization: "Bearer nope" } });
    expect(r.status).toBe(401);
  });
});

describe("limits and stopping", () => {
  beforeEach(async () => { h = await harness(); });

  test("/stop kills the whole process group; its epoch is dead, so nothing is committed, pushed or reported", async () => {
    const t = h.turn({ prompt: "COMMIT SLEEP:60" });
    await h.call("/start", t);
    const a = await until(() => [...h.agent.ctx.active.values()][0]?.running && [...h.agent.ctx.active.values()][0], 10_000, "running");
    const pgid = a.meta.pid!;
    expect(alive(pgid)).toBe(true);
    expect((await h.call("/stop", { thread: "t1", epoch: 2 })).body.ok).toBe(true);   // another epoch: nothing happens
    await Bun.sleep(200);
    expect(alive(pgid)).toBe(true);
    await h.call("/stop", { thread: "t1", epoch: 1 });
    await until(() => h.agent.ctx.active.size === 0, 15_000, "turn dropped");
    expect(alive(pgid)).toBe(false);
    await Bun.sleep(200);
    expect(h.coord.of("/agent/turn-end").length).toBe(0);
    expect(h.originHead("wd/t1")).toBeNull();
    expect(existsSync(join(h.turnDir(t), "ended"))).toBe(true);
  });

  test("/stop also kills descendants in process groups of their own (macOS: the Bash tool's commands)", async () => {
    if (process.platform !== "darwin") return;
    const t = h.turn({ prompt: "GROUPCHILD SLEEP:60" });
    await h.call("/start", t);
    const pidFile = join(h.cfg.dataDir, "wt/t1/group-child.pid");
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, 10_000, "child started");
    const child = Number(readFileSync(pidFile, "utf8"));
    expect(alive(child)).toBe(true);
    await h.call("/stop", { thread: "t1", epoch: 1 });
    await until(() => h.agent.ctx.active.size === 0, 15_000, "turn dropped");
    await until(() => !alive(child), 5_000, "child killed");
  });

  test("a stopped turn never commits the worktree: changes left by the live turn are not pushed", async () => {
    const t = h.turn({ prompt: "SLEEP:60" });
    await h.call("/start", t);
    const a = await until(() => [...h.agent.ctx.active.values()][0]?.running && [...h.agent.ctx.active.values()][0], 10_000, "running");
    writeFileSync(join(h.cfg.dataDir, "wt/t1/half-done.txt"), "x");
    await h.call("/stop", { thread: "t1", epoch: 1 });
    await until(() => h.agent.ctx.active.size === 0, 15_000, "turn dropped");
    expect(alive(a.meta.pid!)).toBe(false);
    expect(sh(join(h.cfg.dataDir, "wt/t1"), "git", "status", "--porcelain")).toContain("half-done.txt");   // still uncommitted
    expect(h.originHead("wd/t1")).toBeNull();
  });

  test("a start for another epoch while the thread has a live turn is refused; a clone that fails is reported as launch-failed", async () => {
    await h.call("/start", h.turn({ prompt: "SLEEP:60" }));
    await until(() => [...h.agent.ctx.active.values()][0]?.running, 10_000, "running");
    const r = await h.call("/start", h.turn({ epoch: 2, turn: 2, resume: true }));
    expect(r.status).toBe(409);
    expect(h.coord.of("/agent/turn-end").length).toBe(0);
    const bad = h.turn({ thread: "t9", branch: "wd/t9", repoId: "acme/other", repoUrl: join(h.root, "no-such-repo.git") });
    expect((await h.call("/start", bad)).status).toBe(200);   // accepted at once; the clone runs in the background
    const end = await endOf("t9");
    expect(end.kind).toBe("launch-failed");
    expect(end.stderrTail).toContain("clone");
  });

  test("runtimeMaxSec ends a turn as timeout", async () => {
    await h.call("/start", h.turn({ prompt: "SLEEP:60", runtimeMaxSec: 1 }));
    const end = await endOf();
    expect(end.kind).toBe("timeout");
  });

  test("a turn killed from outside without our knowing is lost or oom, never silently exited", async () => {
    const t = h.turn({ prompt: "SLEEP:60" });
    await h.call("/start", t);
    const a = await until(() => [...h.agent.ctx.active.values()][0], 5000);
    await until(() => existsSync(join(h.turnDir(t), "pid")) && a.running);
    process.kill(-a.meta.pid!, "SIGKILL");
    const end = await endOf();
    expect(["lost", "oom"]).toContain(end.kind);
  });

  test("a claude that cannot be started is launch-failed with its stderr", async () => {
    await h.agent.close();
    const h2 = await harness({ claude: "/nonexistent/claude" });
    try {
      await h2.call("/start", h2.turn());
      const end = await until(() => h2.coord.ends("t1")[0], 15_000);
      expect(end.kind).toBe("launch-failed");
      expect(end.exitCode).toBe(127);
      expect(end.stderrTail).toContain("nonexistent");
    } finally { await h2.cleanup(); }
  });

  test("a push every pushEverySec during a turn saves commits before the turn ends", async () => {
    await h.cleanup();
    h = await harness({ pushEverySec: 1 });
    await h.call("/start", h.turn({ prompt: "COMMIT SLEEP:6" }));
    await until(() => h.originHead("wd/t1"), 5000, "mid-turn push");
    expect(h.coord.ends("t1").length).toBe(0);
  });
});

describe("resilience", () => {
  beforeEach(async () => { h = await harness(); });

  test("events buffer while the coordinator is down and arrive complete and in order after it returns", async () => {
    const t = h.turn({ prompt: "TICK:15 COMMIT" });
    h.coord.down();
    await h.call("/start", t);
    await Bun.sleep(2500);   // the whole turn ran with nobody to tell
    expect(h.coord.ends("t1").length).toBe(0);
    h.coord.up();
    const end = await endOf();
    expect(end.pushed).toBe(true);
    const types = h.coord.lines.get(key(t))!.map((l) => JSON.parse(l).type);
    expect(types[0]).toBe("system");
    expect(types.at(-1)).toBe("result");
    expect(types.length).toBe(1 + 1 + 15 + 1);   // init, first message, 15 ticks, result
  });

  test("a coordinator that answers 200 without advancing is not hammered in a tight loop", async () => {
    h.coord.frozen = true;
    await h.call("/start", h.turn({ prompt: "COMMIT SLEEP:60" }));
    await until(() => h.coord.of("/agent/events").length > 0, 10_000, "first events post");
    const n0 = h.coord.of("/agent/events").length;
    await Bun.sleep(1000);
    expect(h.coord.of("/agent/events").length - n0).toBeLessThan(40);   // tailMs is 40 ms: about 25, a tight loop would be thousands
  });

  test("a failing events endpoint is retried with the same offset and nothing is applied twice", async () => {
    const t = h.turn({ prompt: "TICK:5" });
    h.coord.failEvents = 3;
    await h.call("/start", t);
    const end = await endOf();
    expect(h.coord.failEvents).toBe(0);
    const file = readFileSync(join(h.turnDir(t), "out.jsonl"), "utf8").trimEnd().split("\n");
    expect(h.coord.lines.get(key(t))).toEqual(file);
    expect(end.result!.isError).toBe(false);
  });

  test("an agent restart mid-turn loses no events and repeats none; the turn still ends once", async () => {
    const t = h.turn({ prompt: "TICK:40 COMMIT" });
    await h.call("/start", t);
    await until(() => (h.coord.lines.get(key(t))?.length ?? 0) >= 5, 10_000, "first events");
    const before = h.coord.lines.get(key(t))!.length;
    await h.restartAgent();
    expect(h.agent.ctx.active.size).toBe(1);   // found again from its turn dir
    const end = await endOf();
    expect(end).toMatchObject({ kind: "exited", pushed: true });
    const got = h.coord.lines.get(key(t))!;
    expect(got.length).toBeGreaterThan(before);
    const file = readFileSync(join(h.turnDir(t), "out.jsonl"), "utf8").trimEnd().split("\n");
    expect(got).toEqual(file);
    expect(h.coord.ends("t1").length).toBe(1);
  });

  test("a turn that finished while the agent was down is reported after the restart, with the push done once", async () => {
    const t = h.turn({ prompt: "COMMIT SLEEP:1" });
    await h.call("/start", t);
    await h.agent.close();
    await until(() => existsSync(join(h.turnDir(t), "exit")), 10_000, "exit file");
    await h.restartAgent();
    const end = await endOf();
    expect(end).toMatchObject({ kind: "exited", pushed: true });
    expect(h.coord.lines.get(key(t))!.at(-1)).toContain('"type":"result"');
  });

  test("a turn-end that cannot be delivered is kept and resent after a restart without pushing again", async () => {
    const t = h.turn({ prompt: "COMMIT" });
    h.coord.failTurnEnd = true;
    await h.call("/start", t);
    await until(() => existsSync(join(h.turnDir(t), "turnend.json")), 10_000, "turnend.json");
    const sent = JSON.parse(readFileSync(join(h.turnDir(t), "turnend.json"), "utf8"));
    await h.agent.close();
    h.coord.failTurnEnd = false;
    await h.restartAgent();
    const end = await endOf();
    expect(end.head).toBe(sent.head);
    expect(end.pushed).toBe(true);
  });

  test("a 409 (stale epoch) stops the turn, sends no turn-end and pushes nothing", async () => {
    h.coord.stale.add("t1");
    const t = h.turn({ prompt: "COMMIT SLEEP:60" });
    await h.call("/start", t);
    const a = await until(() => [...h.agent.ctx.active.values()][0], 5000);
    const pgid = a.meta.pid!;
    await until(() => h.agent.ctx.active.size === 0, 15_000, "turn dropped");
    expect(alive(pgid)).toBe(false);
    expect(h.coord.of("/agent/turn-end").length).toBe(0);
    expect(h.originHead("wd/t1")).toBeNull();
  });
});

describe("heartbeat", () => {
  test("carries the probe and unit status, and acts on a stop reply", async () => {
    h = await harness({ heartbeatSec: 1 });
    const hb0 = await until(() => h.coord.of("/agent/heartbeat")[0], 10_000, "first heartbeat");
    expect(hb0).toMatchObject({ host: "testhost", units: [] });
    expect(hb0.probe).toMatchObject({ claudeVersion: "2.1.0", loginOk: true });
    expect(hb0.probe.cores).toBeGreaterThan(0);

    await h.call("/start", h.turn({ prompt: "SLEEP:60" }));
    const withUnit = await until(() => h.coord.of("/agent/heartbeat").find((b) => b.units.length && b.units[0].running), 10_000, "unit in heartbeat");
    expect(withUnit.units[0]).toMatchObject({ thread: "t1", epoch: 1, turn: 1 });
    const a = [...h.agent.ctx.active.values()][0];
    h.coord.stopReply = [{ thread: "t1", epoch: 1 }];
    await until(() => h.agent.ctx.active.size === 0, 15_000, "turn dropped");
    expect(() => process.kill(-a.meta.pid!, 0)).toThrow();
    expect(h.coord.of("/agent/turn-end").length).toBe(0);
  });
});

describe("release, doctor, probe", () => {
  beforeEach(async () => { h = await harness(); });

  test("release removes the worktree, its tmp and the turn dirs, and keeps the pushed branch", async () => {
    const t = h.turn({ prompt: "COMMIT" });
    await h.call("/start", t);
    await endOf();
    const wt = join(h.cfg.dataDir, "wt/t1");
    expect(existsSync(join(wt, ".wd-tmp"))).toBe(true);
    expect((await h.call("/release", { thread: "t1" })).body.ok).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(h.turnDir(t))).toBe(false);
    expect(sh(join(h.cfg.dataDir, "repos/acme__app.git"), "git", "worktree", "list")).not.toContain("wt/t1");
    expect(h.originHead("wd/t1")).not.toBeNull();
  });

  test("release of a running thread stops it first", async () => {
    const t = h.turn({ prompt: "SLEEP:60" });
    await h.call("/start", t);
    const a = await until(() => [...h.agent.ctx.active.values()][0], 5000);
    await h.call("/release", { thread: "t1" });
    expect(alive(a.meta.pid!)).toBe(false);
    expect(existsSync(join(h.cfg.dataDir, "wt/t1"))).toBe(false);
  });

  test("a second thread on the same repo sees commits pushed to origin after the first", async () => {
    await h.call("/start", h.turn({ prompt: "x" }));
    await endOf();
    const seed = join(h.root, "seed");
    writeFileSync(join(seed, "later"), "later\n");
    sh(seed, "git", "add", "later"); sh(seed, "git", "commit", "-qm", "later"); sh(seed, "git", "push", "-q", "origin", "HEAD:main");
    await h.call("/start", h.turn({ thread: "t2", branch: "wd/t2", prompt: "x" }));
    await endOf("t2");
    expect(existsSync(join(h.cfg.dataDir, "wt/t2/later"))).toBe(true);
    expect(existsSync(join(h.cfg.dataDir, "wt/t1/later"))).toBe(false);
  });

  test("doctor runs the command in a fresh checkout and reports ok, failure and output", async () => {
    const ok = await h.call("/doctor", { repoId: "acme/app", repoUrl: h.origin, command: "test -f README && echo found" });
    expect(ok.body).toEqual({ ok: true, output: "found" });
    const bad = await h.call("/doctor", { repoId: "acme/app", repoUrl: h.origin, command: "echo nope >&2; exit 3" });
    expect(bad.body).toEqual({ ok: false, output: "nope" });
    const none = await h.call("/doctor", { repoId: "acme/gone", repoUrl: join(h.root, "missing.git"), command: "true" });
    expect(none.body.ok).toBe(false);
    expect(none.body.output).toContain("clone");
    expect(existsSync(join(h.cfg.dataDir, "doctor/acme__app"))).toBe(false);
  });

  test("probe reports the host, the version and a working login; a missing login refuses the host", async () => {
    const { resetLoginCache } = await import("../../src/agent/probe");
    resetLoginCache();
    const p = (await h.call("/probe")).body;
    expect(p).toMatchObject({ claudeVersion: "2.1.0", loginOk: true, loginError: null });
    expect(p.loginExpiresAt).toBeGreaterThan(Date.now());
    expect(p.memAvailMb).toBeGreaterThan(0);
    expect(p.diskFreePct).toBeGreaterThan(0);
    expect(p.problems).toEqual([]);

    const home = process.env.HOME;
    process.env.HOME = join(h.root, "nohome");
    require("node:fs").mkdirSync(process.env.HOME, { recursive: true });
    writeFileSync(join(process.env.HOME, ".fake-claude-nologin"), "");
    resetLoginCache();
    try {
      const q = (await h.call("/probe")).body;
      expect(q.loginOk).toBe(false);
      expect(q.problems.join()).toContain("Not logged in");
    } finally { process.env.HOME = home; resetLoginCache(); }
  });
});

describe("orphan sweep", () => {
  beforeEach(async () => { h = await harness(); });
  const age = (p: string, hours = 25) => { const t = new Date(Date.now() - hours * 3600_000); utimesSync(p, t, t); };
  const lease = (name: string, holder: string) => {
    const dir = join(h.cfg.dataDir, "target/acme__app", name + ".lock");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "key"), holder);
    return dir;
  };

  test("removes worktrees, turn dirs and leases of threads the coordinator no longer holds, and nothing else", async () => {
    const D = h.cfg.dataDir, t = (thread: string, prompt: string) => h.turn({ thread, branch: `wd/${thread}`, prompt });
    for (const th of ["t1", "t2", "t4"]) { await h.call("/start", t(th, "COMMIT")); await endOf(th); }
    const t3 = t("t3", "SLEEP:60");
    await h.call("/start", t3);
    const run = await until(() => [...h.agent.ctx.active.values()].find((a) => a.meta.s.thread === "t3" && a.running), 5000);
    const strayTurn = join(D, "turns/t6-1-1");
    mkdirSync(strayTurn, { recursive: true });                     // a turn dir of a vanished thread: no process, no marker
    const liveLease = lease("0", "t1-1-1"), orphanLease = lease("1", "t2-1-1");
    for (const th of ["t1", "t2", "t3"]) for (const p of [join(D, "wt", th), join(D, "turns", `${th}-1-1`)]) age(p);
    for (const p of [strayTurn, liveLease, orphanLease]) age(p);   // t4 stays young

    h.coord.live = null;                                           // the list cannot be fetched: nothing is touched
    expect(await sweepOrphans(h.agent.ctx)).toEqual([]);
    expect(existsSync(join(D, "wt/t2"))).toBe(true);

    h.coord.live = ["t1"];
    const removed = await sweepOrphans(h.agent.ctx);
    expect(removed.sort()).toEqual(["target lease acme__app/1", "turn dir t2-1-1", "turn dir t6-1-1", "worktree t2"]);
    expect(h.coord.reqs.filter((r) => r.path === "/agent/threads")).toHaveLength(3);   // start, then the two sweeps above
    for (const p of ["wt/t1", "turns/t1-1-1", "wt/t3", "turns/t3-1-1", "wt/t4", "turns/t4-1-1"]) expect(existsSync(join(D, p))).toBe(true);
    for (const p of ["wt/t2", "wt/t2.base", "turns/t2-1-1", "turns/t6-1-1", "target/acme__app/1.lock"]) expect(existsSync(join(D, p))).toBe(false);
    expect(existsSync(liveLease)).toBe(true);
    expect(sh(join(D, "repos/acme__app.git"), "git", "worktree", "list")).not.toContain("wt/t2");
    expect(sh(join(D, "repos/acme__app.git"), "git", "worktree", "list")).toContain("wt/t1");
    expect(alive(run.meta.pid!)).toBe(true);                      // t3 is not in the list, but its turn is running

    h.coord.live = ["t1", "t3"];
    expect(await sweepOrphans(h.agent.ctx)).toEqual([]);          // idempotent
    await h.call("/stop", { thread: "t3", epoch: 1 });
  });

  test("a thread with a turn that has no ended marker yet is never removed, listed or not", async () => {
    const t = h.turn({ prompt: "SLEEP:60" });
    await h.call("/start", t);
    await until(() => [...h.agent.ctx.active.values()].find((a) => a.running), 5000);
    age(join(h.cfg.dataDir, "wt/t1")); age(h.turnDir(t));
    h.coord.live = [];
    expect(await sweepOrphans(h.agent.ctx)).toEqual([]);
    expect(existsSync(join(h.cfg.dataDir, "wt/t1"))).toBe(true);
    await h.call("/stop", { thread: "t1", epoch: 1 });
  });

  test("it runs when the agent starts", async () => {
    await h.call("/start", h.turn({ prompt: "COMMIT" }));
    await endOf();
    age(join(h.cfg.dataDir, "wt/t1")); age(h.turnDir(h.turn()));
    h.coord.live = [];
    await h.restartAgent();
    await until(() => !existsSync(join(h.cfg.dataDir, "wt/t1")) && !existsSync(h.turnDir(h.turn())), 10_000, "startup sweep");
  });
});
