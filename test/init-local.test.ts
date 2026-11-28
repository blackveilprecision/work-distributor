// The "try it on one machine" path, end to end and through the CLI only: wd init-local writes the config, wd coord / wd agent
// start from it in the foreground, wd repo add registers a local bare repo, wd submit runs fake-claude and a report comes back.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, ".."), MAIN = join(ROOT, "src/main.ts");
const root = mkdtempSync(join(tmpdir(), "wd-local-")), origin = join(root, "origin.git"), dir = join(root, "inst");
const procs: Bun.Subprocess[] = [];
const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
const free = (p: number) => { try { Bun.serve({ port: p, fetch: () => new Response("") }).stop(true); return true; } catch { return false; } };
const pair = () => { for (;;) { const s = Bun.serve({ port: 0, fetch: () => new Response("") }), p = s.port!; s.stop(true); if (free(p + 1)) return p; } };
const until = async <T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 40_000, what = "condition"): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) { const v = await fn(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
};
// Exactly what a user would run: WD_CLIENT_CONFIG points at the instance, HOME at an empty dir so the real ~/.config/wd is never read.
const wd = async (...args: string[]) => {
  const p = Bun.spawn([process.execPath, MAIN, ...args], {
    env: { ...process.env, HOME: join(root, "home"), WD_CLIENT_CONFIG: join(dir, "client.json"), WD_URL: "", WD_TOKEN: "", WD_CALLER: "" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code: p.exitCode, out: out.trim(), err: err.trim() };
};

beforeAll(() => {
  mkdirSync(join(root, "home"), { recursive: true });
  sh(root, "git", "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  sh(root, "git", "clone", "-q", origin, seed);
  writeFileSync(join(seed, "README"), "seed\n");
  sh(seed, "git", "add", "README"); sh(seed, "git", "commit", "-qm", "seed"); sh(seed, "git", "push", "-q", "origin", "HEAD:main");
});
afterAll(() => {
  for (const p of procs) try { p.kill("SIGKILL"); } catch {}
  Bun.spawnSync(["pkill", "-f", `${root}/`]);   // only turns started under this test's own temp dir
  rmSync(root, { recursive: true, force: true });
});

test("init-local, foreground coord + agent, repo add on a file:// url, submit, report", async () => {
  const base = pair();
  const init = await wd("init-local", dir, "--port-base", String(base));
  expect(init.code).toBe(0);
  expect(init.out).toContain(`coord --config ${dir}/coord.json`);
  expect(init.out).toContain(`export WD_CLIENT_CONFIG=${dir}/client.json`);

  // Test-only tweaks: the fake claude, and floors and timings that suit a busy CI machine.
  const claude = join(root, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, "test/fake-claude.ts"))} "$@"\n`);
  chmodSync(claude, 0o755);
  const edit = (f: string, patch: object) => writeFileSync(join(dir, f), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, f), "utf8")), ...patch }));
  edit("coord.json", { tickMs: 300, floors: { diskFreePct: 0, memReserveMb: 0 } });
  edit("agent.json", { claude, heartbeatSec: 1, tailMs: 100 });

  const env = { ...process.env, HOME: join(root, "home") };
  for (const [role, cfg] of [["coord", "coord.json"], ["agent", "agent.json"]] as const)
    procs.push(Bun.spawn([process.execPath, MAIN, role, "--config", join(dir, cfg)], { env, stdout: "ignore", stderr: "ignore", stdin: "ignore" }));

  await until(async () => (await wd("hosts")).out.startsWith("local\tok"), 60_000, "host local ok");

  const added = await wd("repo", "add", "o/r", "--url", `file://${origin}`);
  expect(added.code).toBe(0);
  expect((await wd("repo", "ls")).out).toContain(`o/r\tfile://${origin}\tmain`);

  const sub = await wd("submit", "o/r", "COMMIT hello", "--tag", "trial");
  expect(sub.code).toBe(0);
  const id = JSON.parse(sub.out).id;
  const report = await until(async () => (JSON.parse((await wd("reports")).out) as any[]).find((r) => r.thread === id), 40_000, "report");
  expect(report).toMatchObject({ kind: "turn", state: "idle", isError: false, pushed: true, tag: "trial", host: "local", branch: `wd/${id}` });
  expect(sh(root, "git", "--git-dir", origin, "rev-parse", `refs/heads/wd/${id}`)).toBe(report.head);
  expect((await wd("repo", "rm", "o/r")).code).toBe(0);
  expect((await wd("repo", "ls")).out).toBe("");
}, 120_000);
