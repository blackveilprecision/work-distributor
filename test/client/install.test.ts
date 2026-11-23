import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentJson, coordInstall, hostInstall, initLocal, launchAgentPlist, releaseUrl, systemdUnit, targetFor, type Target } from "../../src/cli/install.ts";

test("systemd user unit runs the agent from the host's ~/.local/bin and restarts it", () => {
  const u = systemdUnit("/home/u");
  expect(u).toContain("ExecStart=/home/u/.local/bin/wd agent");
  expect(u).toContain("Restart=always");
  expect(u).toContain("WantedBy=default.target");
});

test("LaunchAgent plist has label wd.agent and keeps the agent alive", () => {
  const p = launchAgentPlist("/Users/u");
  expect(p).toContain("<key>Label</key><string>wd.agent</string>");
  expect(p).toContain("<string>/Users/u/.local/bin/wd</string><string>agent</string>");
  expect(p).toContain("<key>KeepAlive</key><true/>");
  expect(p).toContain("/Users/u/Library/Logs/wd-agent.log");
});

test("uname maps to a bun compile target", () => {
  expect(targetFor("Linux x86_64\n").bun).toBe("bun-linux-x64");
  expect(targetFor("Linux aarch64").bun).toBe("bun-linux-arm64");
  expect(targetFor("Darwin arm64").bun).toBe("bun-darwin-arm64");
  expect(() => targetFor("FreeBSD amd64")).toThrow();
});

test("agent.json carries gitTokenFile only when asked for", () => {
  const o = { host: "box1", coordUrl: "http://c:7780", hostToken: "t" };
  expect(agentJson(o, "linux")).toMatchObject({ name: "box1", token: "t", labels: ["linux"] });
  expect(agentJson(o, "linux")).not.toHaveProperty("gitTokenFile");
  expect(agentJson({ ...o, gitTokenFile: "~/.config/wd/git-token" }, "linux").gitTokenFile).toBe("~/.config/wd/git-token");
});

// ---- the install flows, against a recording Target (no ssh, no build, no real machine) ----

function fakeTarget(o: { uname?: string; ip?: string; claude?: string; files?: Record<string, string>; gh?: "wrote" | "kept" | "none" | "nogh"; healthy?: boolean; local?: boolean } = {}) {
  const log: { cmd: string; stdin?: string }[] = [], copied: string[] = [], built: string[] = [], files = { ...o.files };
  const t: Target = {
    name: o.local ? "local" : "u@box", local: !!o.local,
    async sh(cmd, stdin) {
      log.push({ cmd, stdin });
      if (cmd === "bash -s" && stdin?.includes("uname -sm")) return [o.uname ?? "Linux x86_64", "/home/u", "/usr/local/bin:/usr/bin", o.claude ?? "/home/u/.local/bin/claude", o.ip ?? "100.64.0.9"].join("\n") + "\n";
      const m = cmd.match(/^test -f (\S+) &&/);
      if (m) return files[m[1]] !== undefined ? "yes" : "no";
      if (cmd.startsWith("cat ~/.config/wd/coord.json")) return files["~/.config/wd/coord.json"];
      if (cmd.includes("healthz")) return o.healthy === false ? "down" : "up";
      if (cmd === "bash -s" && stdin?.includes("gh auth token")) return o.gh ?? "wrote";
      return "";
    },
    async copy(file, dest) { copied.push(`${file} -> ${dest}`); },
    async build(bunTarget, out) { built.push(`${bunTarget} ${out}`); },
  };
  const stdinOf = (needle: string) => log.find((l) => l.cmd.includes(needle))?.stdin;
  return { t, log, copied, built, stdinOf };
}
const tmp = () => mkdtempSync(join(tmpdir(), "wd-inst-"));

test("coord install on Linux: tailnet listen, random callerToken, wd-coord systemd unit, client.json written", async () => {
  const f = fakeTarget(), clientPath = join(tmp(), "c/client.json"), out: string[] = [];
  await coordInstall("box", {}, f.t, { clientPath, log: (s) => out.push(s) });
  expect(f.built[0]).toMatch(/^bun-linux-x64 .*dist\/wd-linux-x64$/);
  expect(f.copied).toEqual([expect.stringMatching(/wd-linux-x64 -> \.local\/bin\/wd\.new$/)]);
  const cfg = JSON.parse(f.stdinOf("cat > ~/.config/wd/coord.json")!);
  expect(cfg.listen).toBe("100.64.0.9:7780");
  expect(cfg.callerToken).toMatch(/^[0-9a-f]{48}$/);
  expect(f.log.find((l) => l.stdin !== undefined && l.cmd.includes("coord.json"))!.cmd).toContain("umask 077");
  expect(f.stdinOf("wd-coord.service")).toContain("ExecStart=/home/u/.local/bin/wd coord");
  expect(f.log.some((l) => l.cmd.includes("systemctl --user enable wd-coord.service && systemctl --user restart wd-coord.service"))).toBe(true);
  expect(f.log.find((l) => l.cmd.includes("healthz"))!.cmd).toContain("http://100.64.0.9:7780/healthz");
  expect(JSON.parse(readFileSync(clientPath, "utf8"))).toEqual({ url: "http://100.64.0.9:7780", token: cfg.callerToken });   // no caller: it would be one inbox for every session on the machine
  expect(out.join("\n")).toContain("wrote " + clientPath);
});

test("coord install: --listen, loopback fallback, macOS LaunchAgent wd.coord, existing files are kept", async () => {
  const f = fakeTarget({ uname: "Darwin arm64", ip: "", local: true }), clientPath = join(tmp(), "client.json");
  writeFileSync(clientPath, "{\"keep\":true}");
  const out: string[] = [];
  await coordInstall("local", {}, f.t, { clientPath, log: (s) => out.push(s) });
  expect(JSON.parse(f.stdinOf("cat > ~/.config/wd/coord.json")!).listen).toBe("127.0.0.1:7780");
  expect(f.stdinOf("wd.coord.plist")).toContain("<key>Label</key><string>wd.coord</string>");
  expect(f.stdinOf("wd.coord.plist")).toContain("<string>/home/u/.local/bin/wd</string><string>coord</string>");
  expect(f.log.some((l) => l.cmd.includes("launchctl kickstart -k $d/wd.coord"))).toBe(true);
  // bootout is asynchronous: the install must wait for the old service to be gone before bootstrapping it again.
  expect(f.log.some((l) => /bootout.*while launchctl print .*bootstrap/.test(l.cmd))).toBe(true);
  expect(readFileSync(clientPath, "utf8")).toBe("{\"keep\":true}");      // never overwritten, printed instead
  expect(out.join("\n")).toContain("left alone");
  expect(out.join("\n")).toContain("\"url\":\"http://127.0.0.1:7780\"");

  const g = fakeTarget({ files: { "~/.config/wd/coord.json": JSON.stringify({ listen: "0.0.0.0:7790", callerToken: "old" }) } }), p2 = join(tmp(), "client.json");
  await coordInstall("box", { listen: "ignored:1" }, g.t, { clientPath: p2, log: () => {} });
  expect(g.log.some((l) => l.cmd.includes("cat > ~/.config/wd/coord.json"))).toBe(false);
  expect(JSON.parse(readFileSync(p2, "utf8"))).toMatchObject({ url: "http://box:7790", token: "old" });   // 0.0.0.0 -> the ssh host name
  expect(g.log.find((l) => l.cmd.includes("healthz"))!.cmd).toContain("http://127.0.0.1:7790/healthz");
});

test("host install registers with the coordinator, writes the git token from gh and agent.json, starts the unit", async () => {
  const f = fakeTarget(), calls: any[] = [], out: string[] = [];
  const call = async (_c: any, method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    return path === "/hosts" ? [{ name: "box", state: "ok" }] : { token: "regtoken" };
  };
  await hostInstall({ host: "u@box", labels: ["gpu"] }, f.t, { client: { url: "http://100.64.0.1:7780", token: "ct", caller: "c" }, call, waitSec: 0, log: (s) => out.push(s) });
  expect(calls[0]).toEqual({ method: "PUT", path: "/hosts/box", body: { url: "http://100.64.0.9:7781", rotate: true } });
  expect(JSON.parse(f.stdinOf("cat > ~/.config/wd/agent.json")!)).toEqual({
    name: "box", listen: "100.64.0.9:7781", coordUrl: "http://100.64.0.1:7780", token: "regtoken", dataDir: "~/.wd", labels: ["gpu"],
    claude: "/home/u/.local/bin/claude", gitTokenFile: "~/.config/wd/git-token" });
  const gh = f.log.find((l) => l.stdin?.includes("gh auth token"))!.stdin!;
  expect(gh).toContain("umask 077");
  expect(gh).not.toMatch(/ghp_|echo "?\$t/);          // the token is never echoed
  expect(f.stdinOf("wd-agent.service")).toContain("Environment=PATH=/home/u/.local/bin:/usr/local/bin:/usr/bin\n");
  expect(f.log.some((l) => l.cmd.includes("systemctl --user restart wd-agent.service"))).toBe(true);
  expect(out.join("\n")).toContain("git token: wrote ~/.config/wd/git-token on the host from `gh auth token`");
  expect(JSON.parse(f.stdinOf("cat > ~/.config/wd/client.json")!)).toEqual({ url: "http://100.64.0.1:7780", token: "ct" });   // no caller
  expect(f.log.find((l) => l.cmd.includes("cat > ~/.config/wd/client.json"))!.cmd).toContain("umask 077");
  expect(out.at(-1)).toBe("host box is ok");
});

test("host install: an explicit --git-token-file, --coord-url and --host-token skip registration and gh", async () => {
  const f = fakeTarget({ files: { "~/.config/wd/agent.json": "{}" } }), calls: any[] = [];
  await hostInstall({ host: "box", coordUrl: "http://c:7780", hostToken: "given", gitTokenFile: "/x/tok" }, f.t,
    { client: { url: "", token: "", caller: "" }, call: async (...a: any[]) => { calls.push(a); }, log: () => {} });
  expect(calls).toEqual([]);
  expect(f.log.some((l) => l.stdin?.includes("gh auth token"))).toBe(false);
  expect(JSON.parse(f.stdinOf("cat > ~/.config/wd/agent.json")!)).toMatchObject({ token: "given", gitTokenFile: "/x/tok", listen: "100.64.0.9:7781" });
});

test("host install: an existing agent.json is kept and not re-registered; no client config is a clear error; loopback coordinator is refused", async () => {
  const f = fakeTarget({ files: { "~/.config/wd/agent.json": "{}" } }), calls: any[] = [], out: string[] = [];
  await hostInstall({ host: "box" }, f.t, { client: { url: "http://c:1", token: "ct", caller: "" }, call: async (...a: any[]) => { calls.push(a); return []; }, waitSec: 0, log: (s) => out.push(s) });
  expect(calls.map((c) => c[2])).toEqual(["/hosts"]);       // only the status check
  expect(f.log.some((l) => l.cmd.includes("cat > ~/.config/wd/agent.json"))).toBe(false);
  expect(f.log.some((l) => l.cmd.includes("systemctl --user restart wd-agent.service"))).toBe(true);
  expect(f.log.some((l) => l.cmd.includes("cat > ~/.config/wd/client.json"))).toBe(true);   // added on a re-install too
  const kept = fakeTarget({ files: { "~/.config/wd/agent.json": "{}", "~/.config/wd/client.json": "{}" } }), o2: string[] = [];
  await hostInstall({ host: "box" }, kept.t, { client: { url: "http://c:1", token: "ct", caller: "" }, call: async () => [], waitSec: 0, log: (s) => o2.push(s) });
  expect(kept.log.some((l) => l.cmd.includes("cat > ~/.config/wd/client.json"))).toBe(false);
  expect(o2).toContain("kept the existing ~/.config/wd/client.json on the host");
  expect(out.at(-1)).toContain("not visible yet");
  await expect(hostInstall({ host: "box" }, fakeTarget().t, { client: { url: "", token: "", caller: "" }, log: () => {} })).rejects.toThrow("no client config");
  await expect(hostInstall({ host: "box" }, fakeTarget().t, { client: { url: "http://127.0.0.1:7780", token: "ct", caller: "" }, call: async () => ({ token: "t" }), log: () => {} })).rejects.toThrow("loopback");
});

test("host install local: no ssh names, loopback addresses without tailscale, macOS LaunchAgent wd.agent, gh without login", async () => {
  const f = fakeTarget({ uname: "Darwin arm64", ip: "", local: true, gh: "none" }), calls: any[] = [], out: string[] = [];
  await hostInstall({ host: "local", name: "mac" }, f.t, {
    client: { url: "http://127.0.0.1:7780", token: "ct", caller: "" }, waitSec: 0, log: (s) => out.push(s),
    call: async (_c, m, p, b) => { calls.push([m, p, b]); return p === "/hosts" ? [{ name: "mac", state: "refused", reason: "login" }] : { token: "t1" }; } });
  expect(calls[0]).toEqual(["PUT", "/hosts/mac", { url: "http://127.0.0.1:7781", rotate: true }]);
  const cfg = JSON.parse(f.stdinOf("cat > ~/.config/wd/agent.json")!);
  expect(cfg).toMatchObject({ name: "mac", listen: "127.0.0.1:7781", coordUrl: "http://127.0.0.1:7780", labels: ["darwin"] });
  expect(cfg).not.toHaveProperty("gitTokenFile");
  expect(f.stdinOf("wd.agent.plist")).toContain("<key>Label</key><string>wd.agent</string>");
  expect(out.join("\n")).toContain("git token: none");
  expect(out.at(-1)).toContain("host mac is refused: login");
  expect(f.built[0]).toContain("bun-darwin-arm64");
});

test("init-local writes three matching config files, prints the commands, and keeps them on a second run", () => {
  const dir = join(tmp(), "inst"), out: string[] = [];
  initLocal(dir, 18080, (s) => out.push(s), "/bin/claude-x");
  const coord = JSON.parse(readFileSync(join(dir, "coord.json"), "utf8")), agent = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8")), client = JSON.parse(readFileSync(join(dir, "client.json"), "utf8"));
  expect(coord).toMatchObject({ listen: "127.0.0.1:18080", db: join(dir, "wd.sqlite") });
  expect(coord.hosts.local).toEqual({ url: "http://127.0.0.1:18081", token: agent.token });
  expect(agent).toMatchObject({ name: "local", listen: "127.0.0.1:18081", coordUrl: "http://127.0.0.1:18080", dataDir: join(dir, "agent"), claude: "/bin/claude-x" });
  expect(client).toEqual({ url: "http://127.0.0.1:18080", token: coord.callerToken });
  expect(coord.callerToken).not.toBe(agent.token);
  const text = out.join("\n");
  expect(text).toContain(`coord --config ${dir}/coord.json`);
  expect(text).toContain(`agent --config ${dir}/agent.json`);
  expect(text).toContain(`export WD_CLIENT_CONFIG=${dir}/client.json`);
  expect(text.indexOf("export WD_CLIENT_CONFIG")).toBeLessThan(text.indexOf("coord --config"));
  expect(text).toContain(`kill $(cat ${dir}/coord.pid ${dir}/agent.pid)`);
  initLocal(dir, 18080, (s) => out.push(s));
  expect(JSON.parse(readFileSync(join(dir, "client.json"), "utf8"))).toEqual(client);
  expect(out.join("\n")).toContain("already initialised");
  expect(() => initLocal(join(tmp(), "x"), 80, () => {})).toThrow("--port-base");
  expect(existsSync(join(tmp(), "x/coord.json"))).toBe(false);
});

test("coord install warns when WD_CLIENT_CONFIG is set or the existing client.json names another coordinator", async () => {
  const f = fakeTarget(), p = join(tmp(), "client.json"), out: string[] = [];
  writeFileSync(p, JSON.stringify({ url: "http://127.0.0.1:17780", token: "trial" }));
  await coordInstall("box", {}, f.t, { clientPath: p, env: {}, log: (s) => out.push(s) });
  expect(out.join("\n")).toContain("names http://127.0.0.1:17780, not this coordinator (http://100.64.0.9:7780)");
  expect(JSON.parse(readFileSync(p, "utf8")).token).toBe("trial");
  const same = fakeTarget({ files: { "~/.config/wd/coord.json": JSON.stringify({ listen: "100.64.0.9:7780", callerToken: "tok" }) } }), q = join(tmp(), "client.json"), out2: string[] = [];
  writeFileSync(q, JSON.stringify({ url: "http://100.64.0.9:7780/", token: "tok" }));
  await coordInstall("box", {}, same.t, { clientPath: q, env: {}, log: (s) => out2.push(s) });
  expect(out2.join("\n")).not.toContain("warning");
  // with WD_CLIENT_CONFIG set, the file it names is the target; say so
  const w = join(tmp(), "trial.json"), out3: string[] = [];
  await coordInstall("box", {}, fakeTarget().t, { env: { WD_CLIENT_CONFIG: w }, log: (s) => out3.push(s) });
  expect(out3.join("\n")).toContain("warning: WD_CLIENT_CONFIG is set");
  expect(out3.join("\n")).toContain("unset WD_CLIENT_CONFIG");
  expect(existsSync(w)).toBe(true);
});

test("host install: refusals happen before the host is registered or the binary built", async () => {
  const calls: any[] = [], call = async (...a: any[]) => { calls.push(a); return a[2] === "/hosts" ? [] : { token: "t" }; };
  const f = fakeTarget();
  await expect(hostInstall({ host: "box" }, f.t, { client: { url: "http://127.0.0.1:7780", token: "ct", caller: "" }, call, log: () => {} })).rejects.toThrow("loopback");
  expect(calls).toEqual([]);
  expect(f.built).toEqual([]);
  // no Tailscale on a remote host: the ssh name may not resolve from the coordinator, so --agent-url is required
  const g = fakeTarget({ ip: "" });
  await expect(hostInstall({ host: "box" }, g.t, { client: { url: "http://c:7780", token: "ct", caller: "" }, call, log: () => {} })).rejects.toThrow("--agent-url");
  expect(calls).toEqual([]);
  expect(g.built).toEqual([]);
  await hostInstall({ host: "box", agentUrl: "http://10.0.0.5:7781" }, fakeTarget({ ip: "" }).t, { client: { url: "http://c:7780", token: "ct", caller: "" }, call, waitSec: 0, log: () => {} });
  expect(calls[0]).toEqual([expect.anything(), "PUT", "/hosts/box", { url: "http://10.0.0.5:7781", rotate: true }]);
});

test("host install: a coord.json host (the coordinator returns no token) needs --host-token", async () => {
  await expect(hostInstall({ host: "box" }, fakeTarget().t, { client: { url: "http://c:7780", token: "ct", caller: "" }, call: async () => ({ url: "http://x", source: "config" }), log: () => {} })).rejects.toThrow("--host-token");
});

test("probe uses the target's login shell (zsh-only Macs), adds the usual install dirs, and tells gh missing from gh logged out", async () => {
  const f = fakeTarget({ gh: "nogh" }), out: string[] = [];
  await hostInstall({ host: "box" }, f.t, { client: { url: "http://c:7780", token: "ct", caller: "" }, call: async (_c, _m, p) => (p === "/hosts" ? [] : { token: "t" }), waitSec: 0, log: (s) => out.push(s) });
  const probe = f.log.find((l) => l.stdin?.includes("uname -sm"))!;
  expect(probe.cmd).toBe("bash -s");        // plain bash whatever the remote login shell is
  expect(probe.stdin).toContain('"$SHELL"');
  expect(probe.stdin).toContain("zsh");
  expect(probe.stdin).toContain("/opt/homebrew/bin");
  expect(probe.stdin).not.toContain("bash -lc");
  expect(out.join("\n")).toContain("git token: none (gh was not found on the host)");
  expect(out.join("\n")).not.toContain("not logged in");
});

test("host install: claude is also looked up in an interactive login shell, and a re-install that keeps agent.json does not need it", async () => {
  const f = fakeTarget({ claude: "", files: { "~/.config/wd/agent.json": "{}" } }), out: string[] = [];
  await hostInstall({ host: "box" }, f.t, { client: { url: "http://c:1", token: "ct", caller: "" }, call: async () => [], waitSec: 0, log: (s) => out.push(s) });
  expect(out).toContain('installed wd agent "box" on u@box');
  expect(f.log[0].stdin).toContain(`lp 'command -v claude' || li 'command -v claude'`);
  expect(f.log[0].stdin).toMatch(/li\(\) \{ "\$S" -lic /);
  await expect(hostInstall({ host: "box" }, fakeTarget({ claude: "" }).t, { client: { url: "http://c:1", token: "ct", caller: "" }, call: async () => ({ token: "t" }), log: () => {} }))
    .rejects.toThrow("claude not found");
});

test("without a source checkout: a target of this platform gets this very binary, any other downloads this version's release", async () => {
  const pkg = await Bun.file(join(import.meta.dir, "../../package.json")).json();
  const self = { os: "linux", arch: "x64", path: "/opt/brew/bin/wd" }, client = { url: "http://c:1", token: "ct", caller: "" };
  const deps = (out: string[]) => ({ source: null, self, client, call: async () => [], waitSec: 0, log: (s: string) => out.push(s) });
  const same = fakeTarget({ files: { "~/.config/wd/agent.json": "{}" } });
  await hostInstall({ host: "box" }, same.t, deps([]));
  expect(same.built).toEqual([]);
  expect(same.copied).toEqual(["/opt/brew/bin/wd -> .local/bin/wd.new"]);
  expect(same.log.some((l) => l.cmd.includes("curl"))).toBe(false);

  const other = fakeTarget({ uname: "Darwin arm64", files: { "~/.config/wd/agent.json": "{}" } }), out: string[] = [];
  await hostInstall({ host: "box" }, other.t, deps(out));
  expect(other.built).toEqual([]);
  expect(other.copied).toEqual([]);
  const curl = other.log.find((l) => l.cmd.startsWith("curl"))!.cmd;
  expect(curl).toBe(`curl -fsSL -o ~/.local/bin/wd.new 'https://github.com/blackveilprecision/work-distributor/releases/download/v${pkg.version}/wd-darwin-arm64'`);
  expect(other.log.findIndex((l) => l.cmd.startsWith("chmod 755 ~/.local/bin/wd.new"))).toBeGreaterThan(other.log.findIndex((l) => l.cmd.startsWith("curl")));
  expect(out).toContain(`downloading wd ${pkg.version} for darwin-arm64 on u@box`);
  expect(releaseUrl("1.2.3", "linux", "arm64", "https://example.org/fork/releases/download")).toBe("https://example.org/fork/releases/download/v1.2.3/wd-linux-arm64");

  const src = fakeTarget({ files: { "~/.config/wd/agent.json": "{}" } });   // a checkout still builds, as before
  await hostInstall({ host: "box" }, src.t, { ...deps([]), source: "/src/wd" });
  expect(src.built).toEqual(["bun-linux-x64 /src/wd/dist/wd-linux-x64"]);
});
