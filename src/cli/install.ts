// `wd coord install`, `wd host install` and `wd init-local`: build the binary, copy it, write config and a service definition,
// start it. Everything that touches the target goes through a Target, so the steps are tested without ssh.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AGENT_PORT, COORD_PORT, type HostView } from "../shared/types.ts";
import { call, clientConfigPath, loadCfg, type Cfg } from "./client.ts";
import { releaseUrl, VERSION } from "../shared/version.ts";

export type Role = "agent" | "coord";

export const systemdUnit = (home: string, path = `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`, role: Role = "agent") => `[Unit]
Description=wd ${role}
After=network-online.target

[Service]
ExecStart=${home}/.local/bin/wd ${role}
Environment=PATH=${path}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

// Must be a gui/<uid> LaunchAgent: sessions started over ssh cannot reach the keychain and get "Not logged in".
export const launchAgentPlist = (home: string, path = `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, role: Role = "agent") => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>wd.${role}</string>
  <key>ProgramArguments</key><array><string>${home}/.local/bin/wd</string><string>${role}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${home}/Library/Logs/wd-${role}.log</string>
  <key>StandardErrorPath</key><string>${home}/Library/Logs/wd-${role}.log</string>
</dict>
</plist>
`;

// `uname -sm` of the target -> bun compile target.
export function targetFor(uname: string): { os: "linux" | "darwin"; arch: string; bun: string } {
  const [sys, m] = uname.trim().split(/\s+/);
  const os = sys === "Linux" ? "linux" : sys === "Darwin" ? "darwin" : null;
  const arch = m === "x86_64" ? "x64" : m === "aarch64" || m === "arm64" ? "arm64" : null;
  if (!os || !arch) throw new Error(`unsupported host platform: ${uname}`);
  return { os, arch, bun: `bun-${os}-${arch}` };
}

async function run(cmd: string[], stdin?: string): Promise<string> {
  const p = Bun.spawn(cmd, { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")}: exit ${code}: ${err.trim().slice(-500)}`);
  return out;
}

// Where a command runs: another machine over ssh, or this one ("local").
export interface Target {
  name: string; local: boolean;
  sh(cmd: string, stdin?: string): Promise<string>;
  copy(file: string, dest: string): Promise<void>;            // dest is relative to the target's home
  build(bunTarget: string, out: string): Promise<void>;       // compile wd for the target (always runs here)
}

// A source checkout to build the target's binary from: the repo this file is in, WD_SRC, or the current directory. An
// installed wd (brew, a release download) has none.
function srcRoot(): string | null {
  return [process.env.WD_SRC, join(import.meta.dir, "../.."), process.cwd()].find((d) => d && existsSync(join(d, "src/main.ts"))) ?? null;
}
const build = (bunTarget: string, out: string) => run(["bun", "build", "--compile", `--target=${bunTarget}`, join(srcRoot()!, "src/main.ts"), "--outfile", out]).then(() => {});

// The release binary of a version for a platform. WD_RELEASES points a fork at its own releases.
export { releaseUrl };

export const sshTarget = (host: string): Target => ({
  name: host, local: false, build,
  sh: (cmd, stdin) => run(["ssh", "-o", "BatchMode=yes", host, cmd], stdin),
  copy: (file, dest) => run(["scp", "-q", file, `${host}:${dest}`]).then(() => {}),
});
export const localTarget = (): Target => ({
  name: "local", local: true, build,
  sh: (cmd, stdin) => run(["bash", "-c", cmd], stdin),
  copy: (file, dest) => run(["cp", file, join(homedir(), dest)]).then(() => {}),
});
export const openTarget = (host: string) => (host === "local" ? localTarget() : sshTarget(host));

interface Facts { uname: string; home: string; loginPath: string; claude?: string; tsIp?: string }
// The target's own login shell (bash or zsh) supplies its PATH: a Mac with only ~/.zprofile gets Homebrew's PATH there and nowhere else.
// Common install dirs are added when they exist, so claude and gh are still found if the profile does not set them. Sent on stdin to
// `bash -s`, so it works whatever the target's login shell is (fish, ...).
const PROBE_PRELUDE = `S="$SHELL"; case "\${S##*/}" in bash|zsh) ;; *) S=bash;; esac
FIX='for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d";; esac; done;'
lp() { "$S" -lc "$FIX $1" </dev/null; }
li() { "$S" -lic "$FIX $1" </dev/null 2>/dev/null | tail -1; }
`;
// Workers get the target's login PATH (cargo, bun, ...); the services bind to its tailnet address. claude may be on PATH only in an
// interactive shell (~/.bashrc adds linuxbrew), so that is tried too; tail keeps its answer and drops what rc files print.
async function facts(t: Target): Promise<Facts> {
  const [uname, home, loginPath, claude, ip] = (await t.sh("bash -s", PROBE_PRELUDE +
    `uname -sm; echo $HOME; lp 'echo $PATH'; lp 'command -v claude' || li 'command -v claude' || echo; lp 'tailscale ip -4 || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4' 2>/dev/null | head -1\n`,
  )).trim().split("\n");
  return { uname, home, loginPath, claude: claude?.trim() || undefined, tsIp: /^\d+\.\d+\.\d+\.\d+$/.test(ip?.trim() ?? "") ? ip.trim() : undefined };
}

// From a source checkout the target's binary is built here. Without one, this wd copies itself to a target of its own
// platform, and any other target downloads the release binary of this same version.
async function pushBinary(t: Target, f: Facts, d: Deps, log: (s: string) => void): Promise<ReturnType<typeof targetFor>> {
  const tg = targetFor(f.uname), src = d.source !== undefined ? d.source : srcRoot();
  const self = d.self ?? { os: process.platform, arch: process.arch === "arm64" ? "arm64" : "x64", path: process.execPath };
  await t.sh("mkdir -p ~/.local/bin ~/.config/wd");
  if (src) {
    const bin = join(src, "dist", `wd-${tg.os}-${tg.arch}`);
    await t.build(tg.bun, bin);
    await t.copy(bin, ".local/bin/wd.new");
  } else if (tg.os === self.os && tg.arch === self.arch) {
    await t.copy(self.path, ".local/bin/wd.new");
  } else {
    const url = releaseUrl(VERSION, tg.os, tg.arch);
    log(`downloading wd ${VERSION} for ${tg.os}-${tg.arch} on ${t.name}`);
    await t.sh(`curl -fsSL -o ~/.local/bin/wd.new '${url}'`);
  }
  await t.sh("chmod 755 ~/.local/bin/wd.new && mv ~/.local/bin/wd.new ~/.local/bin/wd");
  return tg;
}

async function startService(t: Target, role: Role, os: "linux" | "darwin", home: string, path: string) {
  if (os === "linux") {
    await t.sh(`mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/wd-${role}.service`, systemdUnit(home, path, role));
    await t.sh(`loginctl enable-linger "$USER"; systemctl --user daemon-reload && systemctl --user enable wd-${role}.service && systemctl --user restart wd-${role}.service`);
  } else {
    await t.sh(`mkdir -p ~/Library/LaunchAgents ~/Library/Logs && cat > ~/Library/LaunchAgents/wd.${role}.plist`, launchAgentPlist(home, path, role));
    // bootout returns before the service is gone, and bootstrap fails (error 5) until it is: wait for it, up to 15 s.
    await t.sh(`d=gui/$(id -u); launchctl bootout $d/wd.${role} 2>/dev/null; i=0; while launchctl print $d/wd.${role} >/dev/null 2>&1 && [ $i -lt 30 ]; do sleep 0.5; i=$((i+1)); done; launchctl bootstrap $d ~/Library/LaunchAgents/wd.${role}.plist && launchctl kickstart -k $d/wd.${role}`);
  }
}

const loginPathOf = (f: Facts, claude?: string) => [...new Set([`${f.home}/.local/bin`, claude && dirname(claude), ...f.loginPath.split(":")])].filter(Boolean).join(":");
const sshName = (t: Target) => t.name.split("@").pop()!;
const fileExists = async (t: Target, p: string) => (await t.sh(`test -f ${p} && echo yes || echo no`)).trim() === "yes";
export interface Deps {
  log?: (s: string) => void; client?: Cfg; call?: typeof call; waitSec?: number; clientPath?: string; caller?: string; env?: Record<string, string | undefined>;
  source?: string | null; self?: { os: string; arch: string; path: string };   // tests: where the binary comes from
}

// ---- wd coord install ----
export async function coordInstall(host: string, o: { listen?: string } = {}, t: Target = openTarget(host), d: Deps = {}): Promise<void> {
  const log = d.log ?? console.log, f = await facts(t);
  const tg = await pushBinary(t, f, d, log);
  let cfg: { listen?: string; callerToken: string };
  if (await fileExists(t, "~/.config/wd/coord.json")) {
    cfg = JSON.parse(await t.sh("cat ~/.config/wd/coord.json"));
    log("kept the existing ~/.config/wd/coord.json on the coordinator host");
  } else {
    cfg = { listen: o.listen ?? `${f.tsIp ?? "127.0.0.1"}:${COORD_PORT}`, callerToken: randomBytes(24).toString("hex") };
    await t.sh("umask 077; mkdir -p ~/.config/wd; cat > ~/.config/wd/coord.json", JSON.stringify(cfg, null, 2));
    log(`wrote ~/.config/wd/coord.json (listen ${cfg.listen}, random callerToken)`);
  }
  const listen = cfg.listen ?? `127.0.0.1:${COORD_PORT}`, at = listen.lastIndexOf(":"), [bind, port] = [listen.slice(0, at), listen.slice(at + 1)];
  const wild = bind === "0.0.0.0" || bind === "::";
  await startService(t, "coord", tg.os, f.home, loginPathOf(f));
  const up = (await t.sh(`for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf http://${wild ? "127.0.0.1" : bind}:${port}/healthz >/dev/null && echo up && exit 0; sleep 1; done; echo down`)).trim() === "up";
  log(up ? `coordinator is up at ${listen}` : `coordinator did not answer on ${listen} within 10 s: check its service log on the host`);

  if (!t.local && bind.startsWith("127.")) log(`warning: it listens on the loopback of ${t.name}, so other machines cannot reach it. Delete ~/.config/wd/coord.json there and re-run with --listen <tailscale-ip>:${COORD_PORT}`);
  // No caller: it would be shared by every Claude Code session on this machine (one inbox for all projects). Without it each
  // session defaults to <hostname>:<project dir>; WD_CALLER overrides per session.
  const client = { url: `http://${wild ? (t.local ? "127.0.0.1" : sshName(t)) : bind}:${port}`, token: cfg.callerToken, ...(d.caller ? { caller: d.caller } : {}) };
  const env = d.env ?? process.env, path = d.clientPath ?? clientConfigPath(env);
  if (env.WD_CLIENT_CONFIG && !d.clientPath) log(`warning: WD_CLIENT_CONFIG is set, so this used ${path} instead of ~/.config/wd/client.json. Run \`unset WD_CLIENT_CONFIG\` (for example after the trial instance) and re-run, or \`wd host install\` will register hosts with whatever coordinator that file names`);
  if (existsSync(path)) {
    let old: any = {};
    try { old = JSON.parse(readFileSync(path, "utf8")); } catch {}
    const differs = old.url?.replace(/\/$/, "") !== client.url || old.token !== client.token;
    log(`${path} already exists and was left alone. Client config for this coordinator:\n${JSON.stringify(client)}`);
    if (differs) log(`warning: ${path} names ${old.url ?? "no url"}, not this coordinator (${client.url}): \`wd host install\` and the other wd commands on this machine will use that one. Replace its url and token with the values above if that is not what you want`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(client, null, 2) + "\n", { mode: 0o600 });
    log(`wrote ${path}`);
  }
}

// ---- wd host install ----
export interface InstallOpts { host: string; name?: string; coordUrl?: string; hostToken?: string; labels?: string[]; gitTokenFile?: string; claude?: string; listen?: string; agentUrl?: string }

// gitTokenFile is where the host keeps the GitHub token the agent pushes with; without it pushes would rely on the host's own keyring or ssh agent.
export const agentJson = (o: InstallOpts, os: string) => ({
  name: o.name ?? o.host, listen: o.listen ?? "0.0.0.0:7781", coordUrl: o.coordUrl, token: o.hostToken, dataDir: "~/.wd", labels: o.labels ?? [os],
  ...(o.claude ? { claude: o.claude } : {}),
  ...(o.gitTokenFile ? { gitTokenFile: o.gitTokenFile } : {}),
});

const GIT_TOKEN = "~/.config/wd/git-token";
export async function hostInstall(o: InstallOpts, t: Target = openTarget(o.host), d: Deps = {}): Promise<void> {
  const log = d.log ?? console.log, f = await facts(t);
  o.claude ??= f.claude;
  o.name ??= t.local ? hostname().split(".")[0] : sshName(t);
  o.listen ??= f.tsIp ? `${f.tsIp}:${AGENT_PORT}` : t.local ? `127.0.0.1:${AGENT_PORT}` : `0.0.0.0:${AGENT_PORT}`;
  const client = d.client ?? loadCfg(), api = d.call ?? call;
  const keep = !(o.coordUrl && o.hostToken) && (await fileExists(t, "~/.config/wd/agent.json"));
  if (!o.claude && !keep) throw new Error("claude not found on the host's login PATH: pass --claude <path>");   // a kept agent.json names it
  // Everything that can be refused is checked before the host is registered or the binary built.
  if (!keep) {
    if (!o.hostToken && !client.token) throw new Error("no client config to register the host with: run `wd coord install` first, or set WD_URL and WD_TOKEN, or pass --coord-url and --host-token");
    o.coordUrl ??= client.url;
    if (!t.local && /^https?:\/\/(127\.|localhost)/.test(o.coordUrl)) throw new Error(`coordinator url ${o.coordUrl} is a loopback address that ${t.name} cannot reach: pass --coord-url`);
    if (!o.hostToken && !o.agentUrl && !t.local && !f.tsIp) throw new Error(`no Tailscale address found on ${t.name}, and an ssh name may not resolve from the coordinator: pass --agent-url http://<address the coordinator reaches it at>:${AGENT_PORT}`);
  }
  const agentUrl = o.agentUrl ?? `http://${f.tsIp ?? (t.local ? "127.0.0.1" : sshName(t))}:${AGENT_PORT}`;
  const tg = await pushBinary(t, f, d, log);
  if (keep) log("kept the existing ~/.config/wd/agent.json on the host (delete it to register again)");
  else {
    if (!o.hostToken) {
      // rotate: the host has no agent.json, so it needs a token it has not been given (the coordinator never returns an existing one).
      const r = await api(client, "PUT", `/hosts/${encodeURIComponent(o.name)}`, { url: agentUrl, rotate: true });
      if (!r?.token) throw new Error(`host ${o.name} is defined in the coordinator's coord.json, which keeps its token: pass --host-token <that token> (and --coord-url)`);
      o.hostToken = r.token;
      log(`registered host ${o.name} (${agentUrl}) with the coordinator at ${client.url}`);
    }
    if (!o.gitTokenFile) {
      const r = (await t.sh("bash -s", PROBE_PRELUDE + `lp 'f=${GIT_TOKEN}; if [ -s "$f" ]; then echo kept; elif ! command -v gh >/dev/null 2>&1; then echo nogh; elif t=$(gh auth token 2>/dev/null) && [ -n "$t" ]; then umask 077; mkdir -p ~/.config/wd; printf %s "$t" > "$f"; echo wrote; else echo none; fi'\n`)).trim();
      if (r === "none") log("git token: none (gh is not logged in on the host). Pushes need --git-token-file or a credential helper on the host");
      else if (r === "nogh") log("git token: none (gh was not found on the host). Pushes need --git-token-file or a credential helper on the host");
      else { o.gitTokenFile = GIT_TOKEN; log(r === "wrote" ? `git token: wrote ${GIT_TOKEN} on the host from \`gh auth token\`` : `git token: using the existing ${GIT_TOKEN}`); }
    }
    await t.sh("umask 077; cat > ~/.config/wd/agent.json", JSON.stringify(agentJson(o, tg.os), null, 2));
  }
  await startService(t, "agent", tg.os, f.home, loginPathOf(f, o.claude));
  log(`installed wd agent "${o.name}" on ${t.name}`);
  // So that sessions on the host can submit and read reports too. No caller in it, as for coord install: one per project.
  const url = o.coordUrl ?? client.url;
  if (!t.local && client.token && !/^https?:\/\/(127\.|localhost)/.test(url)) {
    if (await fileExists(t, "~/.config/wd/client.json")) log("kept the existing ~/.config/wd/client.json on the host");
    else {
      await t.sh("umask 077; mkdir -p ~/.config/wd; cat > ~/.config/wd/client.json", JSON.stringify({ url, token: client.token }, null, 2) + "\n");
      log(`wrote ~/.config/wd/client.json on the host (coordinator ${url}), so wd works there too`);
    }
  }
  if (!client.token) return;
  // The agent heartbeats within seconds, but its first headless login check can take longer.
  let h: HostView | undefined;
  for (const end = Date.now() + (d.waitSec ?? 60) * 1000; ; await Bun.sleep(2000)) {
    h = ((await api(client, "GET", "/hosts").catch(() => [])) as HostView[]).find((x) => x.name === o.name);
    if (h?.state === "ok" || Date.now() >= end) break;
  }
  log(h?.state === "ok" ? `host ${o.name} is ok` : `host ${o.name} is ${h?.state ?? "not visible yet"}${h?.reason ? `: ${h.reason}` : ""}. Check \`wd hosts\` again shortly`);
}

// ---- wd init-local ----
// The command that runs this wd: `bun <path>/src/main.ts` from a checkout, the binary itself when compiled.
export const selfCmd = () => (Bun.main.startsWith("/$bunfs") ? process.execPath : `bun ${Bun.main}`);

export function initLocal(dirArg: string, portBase = 17780, log: (s: string) => void = console.log, claude = Bun.which("claude") ?? "claude"): void {
  const dir = resolve(dirArg.replace(/^~(?=\/|$)/, homedir())), file = (n: string) => join(dir, n), wd = selfCmd();
  if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65534) throw new Error("--port-base must be an integer between 1024 and 65534");
  const [cp, ap] = [portBase, portBase + 1], url = `http://127.0.0.1:${cp}`;
  if (existsSync(file("coord.json"))) log(`${dir} is already initialised: keeping its files (the tokens in them must match, so none are rewritten)`);
  else {
    const callerToken = randomBytes(24).toString("hex"), hostToken = randomBytes(24).toString("hex");
    const w = (n: string, v: unknown) => writeFileSync(file(n), JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
    mkdirSync(dir, { recursive: true });
    w("coord.json", { listen: `127.0.0.1:${cp}`, db: file("wd.sqlite"), callerToken, hosts: { local: { url: `http://127.0.0.1:${ap}`, token: hostToken } } });
    w("agent.json", { name: "local", listen: `127.0.0.1:${ap}`, coordUrl: url, token: hostToken, dataDir: file("agent"), claude, labels: [process.platform === "darwin" ? "darwin" : "linux"] });
    w("client.json", { url, token: callerToken });
    log(`wrote coord.json, agent.json and client.json in ${dir} (claude: ${claude})`);
  }
  const [co, ag, cl] = [file("coord.json"), file("agent.json"), file("client.json")];
  log(`\nIn the shell you use wd from, set this first: it points every wd command at this trial. Without it they go to ~/.config/wd/client.json, which is a real install if you have one.\n  export WD_CLIENT_CONFIG=${cl}`);
  log(`\nStart the coordinator and the agent (in the background here; in two terminals just run the two wd commands):\n  nohup ${wd} coord --config ${co} >${file("coord.log")} 2>&1 & echo $! >${file("coord.pid")}\n  nohup ${wd} agent --config ${ag} >${file("agent.log")} 2>&1 & echo $! >${file("agent.pid")}\nStop them with: kill $(cat ${file("coord.pid")} ${file("agent.pid")})   # takes a few seconds`);
  log(`\nThen:\n  ${wd} hosts          # "local" should say ok after a few seconds\n  ${wd} repo add <owner/name> --url <git url, or file:///path/to/repo.git>   # the repo needs at least one commit`);
}
