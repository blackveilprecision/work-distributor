import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCfg } from "../../src/cli/client.ts";
import { cliMain } from "../../src/cli/main.ts";
import { fakeCoord, rep } from "./fake-coord.ts";

let coord: ReturnType<typeof fakeCoord>;
let out: string[];
const saved = { ...process.env };
beforeEach(() => {
  coord = fakeCoord();
  Object.assign(process.env, { WD_URL: coord.url, WD_TOKEN: "tok", WD_CALLER: "t:x", HOME: "/nonexistent" });
  out = [];
  spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { coord.stop(); process.env = { ...saved }; });

test("submit posts caller, options and prompt", async () => {
  expect(await cliMain(["submit", "o/r", "fix", "the", "bug", "--tag", "x", "--require", "gpu", "--require", "linux", "--priority", "--ttl", "2"])).toBe(0);
  expect(coord.reqs.at(-1)!.body).toEqual({ caller: "t:x", repo: "o/r", prompt: "fix the bug", tag: "x", requires: ["gpu", "linux"], priority: true, ttlHours: 2 });
  expect(JSON.parse(out[0])).toEqual({ id: "th1", position: 0 });
});

test("send / cancel / ack hit the right routes; errors exit 1", async () => {
  expect(await cliMain(["send", "th1", "please", "continue"])).toBe(0);
  expect(coord.reqs.at(-1)).toMatchObject({ path: "/threads/th1/send", body: { text: "please continue" } });
  expect(await cliMain(["cancel", "th1"])).toBe(0);
  expect(await cliMain(["ack", "3", "4"])).toBe(0);
  expect(coord.acked).toEqual([3, 4]);
  process.env.WD_TOKEN = "bad";
  expect(await cliMain(["hosts"])).toBe(1);
});

test("reports --pending --hook prints hook JSON and acks", async () => {
  coord.pending.push(rep(1), rep(2, { state: "lost", reason: "host lost", isError: true }));
  expect(await cliMain(["reports", "--pending", "--hook", "--event", "SessionStart"])).toBe(0);
  const o = JSON.parse(out.join("\n"));
  expect(o.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(o.hookSpecificOutput.additionalContext).toContain("thread th1");
  expect(o.hookSpecificOutput.additionalContext).toContain("reason: host lost");
  expect(coord.acked.sort()).toEqual([1, 2]);
});

test("hook prints nothing when there are no reports", async () => {
  expect(await cliMain(["reports", "--pending", "--hook"])).toBe(0);
  expect(out).toEqual([]);
});

test("hook prints nothing and exits 0 when the coordinator is unreachable or rejects", async () => {
  process.env.WD_URL = "http://127.0.0.1:1";
  expect(await cliMain(["reports", "--pending", "--hook"])).toBe(0);
  process.env.WD_URL = coord.url;
  process.env.WD_TOKEN = "bad";
  expect(await cliMain(["reports", "--pending", "--hook"])).toBe(0);
  expect(out).toEqual([]);
});

test("repo add/ls/rm: the id is URL-encoded, the url defaults to GitHub", async () => {
  expect(await cliMain(["repo", "add", "acme/shop", "--ref", "dev", "--doctor", "bun --version", "--require", "gpu", "--rust"])).toBe(0);
  expect(coord.reqs.at(-1)).toMatchObject({ method: "PUT", path: "/repos/acme%2Fshop",
    body: { url: "https://github.com/acme/shop.git", defaultRef: "dev", doctor: "bun --version", requires: ["gpu"], rust: true } });
  expect(await cliMain(["repo", "add", "acme/api", "--url", "file:///tmp/api.git"])).toBe(0);
  expect(coord.reqs.at(-1)!.body).toEqual({ url: "file:///tmp/api.git" });
  out.length = 0;
  expect(await cliMain(["repo", "ls"])).toBe(0);
  expect(out).toEqual(["acme/shop\tu\tmain\ttrue\tgpu\trust\tdb"]);
  expect(await cliMain(["repo", "rm", "acme/shop"])).toBe(0);
  expect(coord.reqs.at(-1)).toMatchObject({ method: "DELETE", path: "/repos/acme%2Fshop" });
  expect(await cliMain(["repo", "add"])).toBe(2);   // a usage mistake: exit 2 with the command's help
});

test("WD_CLIENT_CONFIG names the client.json to read; env vars still win", () => {
  const f = join(mkdtempSync(join(tmpdir(), "wd-cc-")), "client.json");
  writeFileSync(f, JSON.stringify({ url: "http://c:1/", token: "T", caller: "x:y" }));
  expect(loadCfg({ WD_CLIENT_CONFIG: f, HOME: "/nonexistent" })).toEqual({ url: "http://c:1", token: "T", caller: "x:y" });
  expect(loadCfg({ WD_CLIENT_CONFIG: f, WD_TOKEN: "env" }).token).toBe("env");
});

test("reports --wait blocks until the caller has a pending report, prints it and leaves it unacked", async () => {
  setTimeout(() => coord.pending.push(rep(7)), 300);
  expect(await cliMain(["reports", "--wait", "--caller", "orch:shop"])).toBe(0);
  expect(JSON.parse(out[0]).map((r: any) => r.id)).toEqual([7]);
  expect(coord.reqs.every((r) => r.path.includes("caller=orch%3Ashop"))).toBe(true);
  expect(coord.acked).toEqual([]);
});

test("reports --wait fails at once on a bad token", async () => {
  process.env.WD_TOKEN = "bad";
  expect(await cliMain(["reports", "--wait"])).toBe(1);
});

test("wd --version prints the package.json version (what a release tag must match)", async () => {
  const pkg = await Bun.file(new URL("../../package.json", import.meta.url).pathname).json();
  for (const flag of ["--version", "-V", "version"]) {
    const r = Bun.spawnSync([process.execPath, new URL("../../src/main.ts", import.meta.url).pathname, flag]);
    expect(r.stdout.toString().trim()).toBe(pkg.version);
  }
});

test("help: every level explains itself, without colour codes off a terminal; usage mistakes exit 2", async () => {
  const errs: string[] = [];
  (console.error as any).mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
  expect(await cliMain([])).toBe(0);
  expect(out.join("\n")).toContain("USAGE wd submit|ls|status|");
  expect(out.join("\n")).not.toMatch(/\x1b\[/);
  out.length = 0;
  expect(await cliMain(["submit", "--help"])).toBe(0);
  expect(out.join("\n")).toMatch(/USAGE wd submit \[OPTIONS\] <REPO> <PROMPT>[\s\S]*--require=<label>\s+Host label the thread needs; repeat for several/);
  out.length = 0;
  expect(await cliMain(["help", "repo", "add"])).toBe(0);
  expect(out.join("\n")).toContain("USAGE wd repo add [OPTIONS] <ID>");
  out.length = 0;
  expect(await cliMain(["host", "install", "-h"])).toBe(0);
  expect(out.join("\n")).toContain("--label=<label>");
  expect(await cliMain(["bogus"])).toBe(2);
  expect(errs.at(-1)).toMatch(/USAGE wd submit[\s\S]*wd: Unknown command bogus$/);
  expect(await cliMain(["status"])).toBe(2);
  expect(errs.at(-1)).toMatch(/USAGE wd status[\s\S]*wd: Missing required positional argument: ID$/);
  expect(coord.reqs).toEqual([]);
});

test("repeated flags keep every value, and flags may follow the words", async () => {
  expect(await cliMain(["submit", "o/r", "--require", "gpu", "do", "it", "--require=linux", "--size", "heavy"])).toBe(0);
  expect(coord.reqs.at(-1)!.body).toMatchObject({ repo: "o/r", prompt: "do it", requires: ["gpu", "linux"], size: "heavy" });
  expect(await cliMain(["send", "th1", "more", "--caller", "other"])).toBe(0);
  expect(coord.reqs.at(-1)).toMatchObject({ path: "/threads/th1/send", body: { text: "more" } });
});

test("an unknown or mistyped option is refused with the command's help, not silently ignored", async () => {
  const errs: string[] = [];
  (console.error as any).mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
  expect(await cliMain(["submit", "o/r", "do", "it", "--requre", "gpu"])).toBe(2);
  expect(errs.at(-1)).toMatch(/USAGE wd submit[\s\S]*wd: unknown option --requre$/);
  expect(await cliMain(["repo", "add", "a/b", "--doctr=x"])).toBe(2);
  expect(await cliMain(["tail", "th1", "-x"])).toBe(2);
  expect(coord.reqs).toEqual([]);
  // defined flags in every spelling still work, and so do `-` (stdin) and words after `--`
  expect(await cliMain(["submit", "o/r", "--", "--literally", "this"])).toBe(0);
  expect(coord.reqs.at(-1)!.body.prompt).toBe("--literally this");
  expect(await cliMain(["ls", "--all", "--caller=x"])).toBe(0);
  expect(await cliMain(["reports", "--pending", "--hook", "--bogus"])).toBe(0);   // the hook never fails
});

test("client calls wait out a coordinator that is restarting, but not forever", async () => {
  const { call } = await import("../../src/cli/client.ts");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const cfg = { url: `http://127.0.0.1:${port}`, token: "t", caller: "c" };
  let server: ReturnType<typeof Bun.serve> | undefined;
  setTimeout(() => { server = Bun.serve({ port, fetch: () => Response.json({ up: true }) }); }, 700);
  try {
    expect(await call(cfg, "POST", "/threads", {})).toEqual({ up: true });
  } finally { server?.stop(true); }
  await expect(call(cfg, "GET", "/hosts", undefined, 1000, 0)).rejects.toThrow();
});
