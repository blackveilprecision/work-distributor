import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, claudeArgs, cpuCounter, cpuMsOf, status, sweep, type TurnMeta, parsePs, piArgs, quote, runScript, sessionEnv, systemdRunArgs, treeOf, turnEnv, outside, cargoWrapper } from "../../src/agent/launch";
import { readLines } from "../../src/agent/tail";
import { authArgs, leaseTarget, poolSize, releaseTarget } from "../../src/agent/workspace";
import { envFromFile, loadConfig } from "../../src/agent/config";
import type { StartTurn } from "../../src/shared/types";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "wd-unit-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const start = (o: Partial<StartTurn> = {}): StartTurn => ({ thread: "t1", epoch: 3, turn: 2, repoUrl: "u", repoId: "a/b", ref: "main", branch: "wd/t1", sessionId: "sid", resume: false, prompt: "p", memoryMaxMb: 2048, runtimeMaxSec: 600, rust: false, ...o });

describe("systemd launch (argument building only)", () => {
  test("systemd-run line carries the limits and runs run.sh by path, without --collect", () => {
    const a = systemdRunArgs({ unit: "wd-t1-3-2", dir: "/d/turns/t1-3-2", cwd: "/d/wt/t1", memoryMb: 2048, seconds: 600 });
    expect(a).toEqual(["--user", "--quiet", "--unit=wd-t1-3-2", "-p", "MemoryMax=2048M", "-p", "RuntimeMaxSec=600", "-p", "TimeoutStopSec=10", "--working-directory=/d/wt/t1", "/bin/bash", "/d/turns/t1-3-2/run.sh"]);
    expect(a).not.toContain("--collect");
    expect(systemdRunArgs({ unit: "u", dir: "/d", cwd: "/c", memoryMb: 1, seconds: 0 })).toContain("RuntimeMaxSec=infinity");
  });

  test("classify: a unit's Result wins over the exit file; a gone unit is read by the exit file", () => {
    const u = (active: string, result: string) => ({ load: "loaded", active, result });
    expect(classify(u("failed", "oom-kill"), 137, null, "systemd")).toEqual({ kind: "oom", exitCode: 137 });
    expect(classify(u("failed", "timeout"), null, null, "systemd").kind).toBe("timeout");
    expect(classify(u("failed", "signal"), null, null, "systemd").kind).toBe("killed");
    expect(classify({ load: "not-found", active: "inactive", result: "success" }, 0, null, "systemd")).toEqual({ kind: "exited", exitCode: 0 });
    expect(classify({ load: "not-found", active: "inactive", result: "success" }, null, null, "systemd").kind).toBe("lost");
    expect(classify(u("failed", "oom-kill"), 1, "killed", "systemd").kind).toBe("killed");   // our own stop is ours
    expect(classify(null, null, "timeout", "pgroup").kind).toBe("timeout");
    expect(classify(null, 137, null, "pgroup").kind).toBe("oom");
    expect(classify(null, 137, null, "systemd").kind).toBe("exited");
  });
});

describe("run script and environment", () => {
  test("quote survives quotes, spaces and dollars", () => {
    expect(quote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
    const r = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${quote("it's $HOME `x`")}`]);
    expect(r.stdout.toString()).toBe("it's $HOME `x`");
  });

  test("turnEnv is fixed and never carries credentials", () => {
    process.env.GH_TOKEN = "a"; process.env.GITHUB_TOKEN = "b"; process.env.SSH_AUTH_SOCK = "c"; process.env.RANDOM_THING = "d";
    try {
      const e = turnEnv(start(), "/wt/t1", { target: "/t/0", sccache: "/bin/sccache" });
      expect(Object.keys(e).sort()).toEqual(["CARGO_TARGET_DIR", "DISABLE_AUTOUPDATER", "HOME", "LOGNAME", "PATH", "RUSTC_WRAPPER", "SHELL", "TMPDIR", "USER", "WD_KEY", "WD_THREAD"]);
      expect(e).toMatchObject({ WD_KEY: "t1-3", WD_THREAD: "t1", TMPDIR: "/wt/t1/.wd-tmp", SHELL: "/bin/bash", DISABLE_AUTOUPDATER: "1" });
      expect(Object.keys(turnEnv(start(), "/wt/t1"))).not.toContain("CARGO_TARGET_DIR");
    } finally { for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "RANDOM_THING"]) delete process.env[k]; }
  });

  test("turnEnv merges the envFile's vars; the fixed entries still win", () => {
    const e = turnEnv(start(), "/wt/t1", { extra: { ANTHROPIC_API_KEY: "sk-ant-1", HOME: "/evil", USER: "root", PATH: "/evil/bin" } });
    expect(e.ANTHROPIC_API_KEY).toBe("sk-ant-1");
    expect(e.HOME).not.toBe("/evil");
    expect(e.USER).not.toBe("root");
    expect(e.PATH).not.toBe("/evil/bin");
  });

  test("envFromFile: KEY=value lines, comments and blanks skipped, export stripped, junk dropped", () => {
    const f = join(tmp(), "api-keys.env");
    writeFileSync(f, "# a key\nexport ANTHROPIC_API_KEY = sk-ant-123\nDEEPSEEK_API_KEY=ds-456\n\nBAD LINE\n1BAD=x\nA=1\n");
    expect(envFromFile(f)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-123", DEEPSEEK_API_KEY: "ds-456", A: "1" });
    expect(envFromFile(join(tmp(), "missing.env"))).toEqual({});
  });

  test("claudeArgs: session-id on the first turn, resume later, model only when asked", () => {
    expect(claudeArgs(start())).toContain("--session-id");
    expect(claudeArgs(start({ resume: true }))).toEqual(expect.arrayContaining(["--resume", "sid"]));
    expect(claudeArgs(start({ resume: true }))).not.toContain("--session-id");
    expect(claudeArgs(start())).not.toContain("--model");
    expect(claudeArgs(start({ model: "opus" }))).toEqual(expect.arrayContaining(["--model", "opus"]));
    const settings = JSON.parse(claudeArgs(start())[claudeArgs(start()).indexOf("--settings") + 1]);
    expect(settings).toEqual({ crossSessionInbound: "refuse", syncClaudeAiPlugins: false, syncClaudeAiSkills: false });
  });

  test("piArgs: print + json stream, --session-id every turn, no MCP, model only when asked", () => {
    const a = piArgs(start());
    expect(a).toEqual(["-p", "--mode", "json", "--approve", "--no-mcp", "--session-id", "sid"]);
    expect(piArgs(start({ resume: true }))).toContain("--session-id");
    expect(piArgs(start({ model: "deepseek/deepseek-flash" }))).toEqual(expect.arrayContaining(["--model", "deepseek/deepseek-flash"]));
  });

  test("piArgs billing: only api billing passes --api-key, and only for anthropic models; session (the default) never does", () => {
    const anth = { model: "anthropic/claude-sonnet-5-5:high" }, ds = { model: "deepseek/deepseek-flash" };
    expect(piArgs(start({ ...anth, billing: "api" }), "sk-ant-1")).toEqual(expect.arrayContaining(["--api-key", "sk-ant-1"]));
    expect(piArgs(start({ ...ds, billing: "api" }), "sk-ant-1")).not.toContain("--api-key");
    expect(piArgs(start(anth), "sk-ant-1")).not.toContain("--api-key");   // no billing: session
    expect(piArgs(start({ ...anth, billing: "session" }), "sk-ant-1")).not.toContain("--api-key");
    expect(() => piArgs(start({ ...anth, billing: "api" }))).toThrow("ANTHROPIC_API_KEY");
    expect(() => piArgs(start(anth))).not.toThrow();
  });

  test("sessionEnv drops API keys and keeps everything else", () => {
    expect(sessionEnv({ ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "b", WD_THREAD: "t", FOO: "1" })).toEqual({ WD_THREAD: "t", FOO: "1" });
    expect(sessionEnv({})).toEqual({});
  });

  test("runScript writes exit atomically and reads the prompt from a file", () => {
    const s = runScript("/d/x y", "/bin/claude", ["-p"], { A: "1 2" });
    expect(s).toContain(`JOB='/d/x y'`);
    expect(s).toContain(`env -i 'A=1 2' '/bin/claude' '-p' < "$JOB/prompt.txt" > "$JOB/out.jsonl" 2> "$JOB/err.log"`);
    expect(s).toContain(`echo $? > "$JOB/exit.tmp"; mv "$JOB/exit.tmp" "$JOB/exit"`);
  });

  test("ps parsing: group members, rss and cpu time in both macOS and Linux formats", () => {
    expect(cpuMsOf("0:01.50")).toBe(1500);
    expect(cpuMsOf("1:02:03.00")).toBe(3_723_000);
    expect(cpuMsOf("2-00:00:01")).toBe(172_801_000);
    const rows = parsePs("  10  1  10  2048 Ss  0:00.10 /bin/bash /d/turns/t/run.sh\n  11  10  10  4096 S   0:02.00 node x y z\ngarbage\n");
    expect(rows).toEqual([
      { pid: 10, ppid: 1, pgid: 10, rssKb: 2048, stat: "Ss", cpuMs: 100, cmd: "/bin/bash /d/turns/t/run.sh" },
      { pid: 11, ppid: 10, pgid: 10, rssKb: 4096, stat: "S", cpuMs: 2000, cmd: "node x y z" },
    ]);
  });

  test("linux: work a turn started outside its unit is found by working directory, with its descendants", () => {
    const proc = tmp(), wt = "/home/u/.wd/wt/t1";
    // stat fields after "(comm) ": state ppid pgrp ... utime(12th) stime(13th) ... rss(22nd)
    const stat = (pid: number, ppid: number, ticks: number, pages: number) =>
      `${pid} (x) S ${ppid} ${pid} ${Array(8).fill(0).join(" ")} ${ticks} 0 ${Array(8).fill(0).join(" ")} ${pages} 0`;
    const add = (pid: number, ppid: number, cwd: string, cg: string, ticks: number, pages: number) => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, `${pid}/stat`), stat(pid, ppid, ticks, pages));
      writeFileSync(join(proc, `${pid}/cgroup`), `0::/user.slice/${cg}\n`);
      symlinkSync(cwd, join(proc, `${pid}/cwd`));
    };
    add(10, 1, wt, "app.slice/wd-t1-1-1.service", 500, 1000);          // the turn itself: the unit counts it
    add(20, 1, wt, "app.slice/hc-server.service", 100, 256);           // an hc terminal in the worktree
    add(21, 20, "/home/u/.cargo/registry/x", "app.slice/hc-server.service", 300, 512);   // its compiler, elsewhere
    add(30, 1, "/home/u/other", "app.slice/hc-server.service", 900, 9999);           // unrelated
    add(40, 1, `${wt}/sub`, "app.slice/wd-t1-1-1.service/inner.scope", 50, 50);     // nested in the unit
    // The first look is a baseline (an agent restart must not count their past CPU at once); growth after it counts.
    expect(outside({ key: "t1-1-1", wt, unit: "wd-t1-1-1" }, proc)).toEqual({ cpuMs: 0, memMb: 3 });   // (256+512) pages x 4 KiB
    writeFileSync(join(proc, "21/stat"), stat(21, 20, 700, 512));
    expect(outside({ key: "t1-1-1", wt, unit: "wd-t1-1-1" }, proc)).toEqual({ cpuMs: 4000, memMb: 3 });   // 400 more ticks x 10 ms
  });

  test("a turn's processes are its group and every descendant, also in process groups of their own", () => {
    const p = (pid: number, ppid: number, pgid: number) => ({ pid, ppid, pgid, rssKb: 1, stat: "S", cpuMs: 0, cmd: "x" });
    // 10 run.sh -> 11 claude -> 20 bash (own group, as Claude Code's Bash tool does) -> 21 cargo -> 22 rustc; 30 is unrelated
    const rows = [p(10, 1, 10), p(11, 10, 10), p(20, 11, 20), p(21, 20, 20), p(22, 21, 20), p(30, 1, 30)];
    expect(treeOf(rows, (r) => r.pgid === 10).map((r) => r.pid).sort()).toEqual([10, 11, 20, 21, 22]);
  });
});

describe("tailer reader", () => {
  const file = () => join(tmp(), "out.jsonl");

  test("returns complete lines with their byte offsets and holds a half-written line for next time", () => {
    const f = file();
    writeFileSync(f, 'one\ntwo\npart');
    let r = readLines(f, 0, false);
    expect(r.lines.map((l) => [l.at, l.text])).toEqual([[0, "one"], [4, "two"]]);
    expect(r.next).toBe(8);
    appendFileSync(f, "ial\n");
    r = readLines(f, r.next, false);
    expect(r.lines).toEqual([{ at: 8, text: "partial" }]);
    expect(r.next).toBe(16);
  });

  test("with final, an unterminated last line counts; offsets are bytes, not chars", () => {
    const f = file();
    writeFileSync(f, "é1\nlast");
    const r = readLines(f, 0, true);
    expect(r.lines.map((l) => [l.at, l.text])).toEqual([[0, "é1"], [4, "last"]]);
    expect(r.next).toBe(8);
    expect(readLines(f, r.next, true)).toEqual({ lines: [], next: 8 });
  });

  test("a missing file is simply empty", () => {
    expect(readLines(join(tmp(), "none"), 5, false)).toEqual({ lines: [], next: 5 });
  });

  test("a line of 20 MB spanning many chunks is read whole, cut to 8000 chars, and the next line is intact", () => {
    const f = file();
    writeFileSync(f, "a\n");
    appendFileSync(f, "x".repeat(20 * 1024 * 1024));
    const half = readLines(f, 0, false);
    expect(half.lines.length).toBe(1);   // the long line is not finished
    expect(half.next).toBe(2);
    appendFileSync(f, '\n{"type":"result","is_error":false}\n');
    const r = readLines(f, half.next, false);
    expect(r.lines.length).toBe(2);
    expect(r.lines[0].text.length).toBe(8000);
    expect(r.lines[1]).toEqual({ at: 2 + 20 * 1024 * 1024 + 1, text: '{"type":"result","is_error":false}', result: '{"type":"result","is_error":false}' });
  });

  test("a huge multi-byte line is truncated by characters without breaking", () => {
    const f = file();
    writeFileSync(f, "日".repeat(30000) + "\n");
    const l = readLines(f, 0, false).lines[0];
    expect(l.text.length).toBe(8000);
    expect(l.text).toBe("日".repeat(8000));
  });

  test("a huge result line is kept whole for parsing", () => {
    const f = file();
    const body = JSON.stringify({ type: "result", is_error: false, result: "y".repeat(50000) });
    writeFileSync(f, body + "\n");
    const l = readLines(f, 0, false).lines[0];
    expect(l.text.length).toBe(8000);
    expect(JSON.parse(l.result!).result.length).toBe(50000);
  });
});

describe("workspace pieces", () => {
  const cfg = (dataDir: string, extra = {}) => ({ name: "h", listen: "x", coordUrl: "x", token: "x", dataDir, claude: "c", labels: [], maxThreads: 1, targetDirPool: 2, heartbeatSec: 1, tailMs: 1, pushEverySec: 1, ...extra });

  test("the git credential helper reads the token file at run time and clears other helpers", () => {
    expect(authArgs(cfg("/d"))).toEqual([]);
    const a = authArgs(cfg("/d", { gitTokenFile: "/home/x/.config/wd/git-token" }));
    expect(a[1]).toBe("credential.helper=");
    expect(a[3]).toContain("cat '/home/x/.config/wd/git-token'");
    expect(a.join(" ")).not.toContain("ghp_");
  });

  test("target dir pool: capped, warmest free dir first, stale locks taken over, one holder at a time", () => {
    const d = tmp(), c = cfg(d);
    const live = new Set<string>();
    const lease = (k: string) => { live.add(k); return leaseTarget(c, "a/b", k, (x) => live.has(x)); };
    const a = lease("k1")!, b = lease("k2")!;
    expect(a).not.toBe(b);
    expect(lease("k3")).toBeNull();   // cap of 2 reached
    expect(poolSize(c, "a/b")).toBe(2);
    writeFileSync(join(b, "warm"), "x");
    releaseTarget(b);
    live.delete("k2");
    releaseTarget(a);
    live.delete("k1");
    expect(lease("k4")).toBe(a);   // released last, so warmest
    expect(lease("k5")).toBe(b);
    // a crashed turn: its lock stays but nothing is live any more
    live.clear();
    expect(lease("k6")).not.toBeNull();
    expect(existsSync(join(b, "warm"))).toBe(true);   // reuse keeps the warm contents
  });

  test("config: defaults, ~ expansion and required keys", () => {
    const f = join(tmp(), "agent.json");
    writeFileSync(f, JSON.stringify({ name: "n", coordUrl: "http://c", token: "t", dataDir: "~/.wd-test", claude: "~/.local/bin/claude", gitTokenFile: "~/tok" }));
    const c = loadConfig(f);
    expect(c.dataDir).toBe(join(process.env.HOME!, ".wd-test"));
    expect(c.claude).toBe(join(process.env.HOME!, ".local/bin/claude"));
    expect(c).toMatchObject({ heartbeatSec: 15, labels: [] });
    expect(c.maxThreads).toBeUndefined();   // no cap unless set
    writeFileSync(f, JSON.stringify({ name: "n" }));
    expect(() => loadConfig(f)).toThrow("coordUrl");
  });
});

describe("darwin process group (ps based)", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  test("cpuCounter adds per-pid growth and never goes down when processes exit", () => {
    expect(cpuCounter("k", [{ pid: 1, cpuMs: 100 }, { pid: 2, cpuMs: 50 }])).toBe(150);
    expect(cpuCounter("k", [{ pid: 1, cpuMs: 120 }])).toBe(170);                    // pid 2 exited: not subtracted
    expect(cpuCounter("k", [{ pid: 1, cpuMs: 120 }, { pid: 3, cpuMs: 10 }])).toBe(180);   // a new pid counts from its first sight
    expect(cpuCounter("k", [])).toBe(180);
  });

  test("a survivor of the group is still ours, running and killed by sweep after run.sh is gone", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "run.sh"), "(trap '' TERM; exec sleep 300) &\nexit 0\n");   // the leader exits at once, the child ignores TERM
    const p = Bun.spawn(["/bin/bash", join(dir, "run.sh")], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
    p.unref();
    const meta: TurnMeta = { s: start(), key: "t1-3-2", dir, wt: dir, mode: "pgroup", pid: p.pid, unit: null, startedAt: Date.now(), target: null };
    await p.exited;
    await Bun.sleep(200);
    try {
      expect((await status(meta)).running).toBe(true);
      await sweep(meta);
      await Bun.sleep(300);
      expect((await status(meta)).running).toBe(false);
    } finally {
      try { process.kill(-p.pid, "SIGKILL"); } catch {}
    }
    expect(alive(p.pid)).toBe(false);
  });
});

test("the speed benchmark gives a positive score", async () => {
  const { bench } = await import("../../src/agent/probe");
  expect(bench(20)).toBeGreaterThan(0);
});

test("the speed score is the best seen, and a saved one survives a restart", async () => {
  const { speed } = await import("../../src/agent/probe");
  const file = join(mkdtempSync(join(tmpdir(), "wd-speed-")), "speed");
  writeFileSync(file, "999999");   // measured while the host was quiet
  expect(speed(file)).toBe(999999);
  expect(require("node:fs").readFileSync(file, "utf8")).toBe("999999");
});

test("a rustc-wrapper in the host's or the repo's cargo config keeps wd from setting RUSTC_WRAPPER", () => {
  const home = mkdtempSync(join(tmpdir(), "wd-home-")), wt = mkdtempSync(join(tmpdir(), "wd-wt-"));
  expect(cargoWrapper(home, wt)).toBe(false);
  mkdirSync(join(home, ".cargo"));
  writeFileSync(join(home, ".cargo/config.toml"), '[build]\njobs = 4\n');
  expect(cargoWrapper(home, wt)).toBe(false);
  writeFileSync(join(home, ".cargo/config.toml"), '[build]\nrustc-wrapper = "/home/u/.local/bin/kache"\n');
  expect(cargoWrapper(home, wt)).toBe(true);
  rmSync(join(home, ".cargo/config.toml"));
  mkdirSync(join(wt, ".cargo"));
  writeFileSync(join(wt, ".cargo/config"), 'build.rustc-wrapper = "x"\n');
  expect(cargoWrapper(home, wt)).toBe(true);
});
