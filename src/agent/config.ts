import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";

export interface AgentConfig {
  name: string; listen: string; coordUrl: string; token: string; dataDir: string; claude: string;
  labels: string[]; gitTokenFile?: string; maxThreads: number; targetDirPool: number;
  path?: string;   // PATH for doctors and turns; without it, the host's interactive login shell's PATH (see loginPath)
  heartbeatSec: number; tailMs: number; pushEverySec: number;   // tuning knobs, tests shorten them
}

export const expand = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

export function loadConfig(path?: string): AgentConfig {
  const file = path ?? process.env.WD_AGENT_CONFIG ?? join(homedir(), ".config/wd/agent.json");
  if (!existsSync(file)) throw new Error(`agent config not found: ${file}`);
  const c = { ...JSON.parse(readFileSync(file, "utf8")) };
  const cfg: AgentConfig = {
    listen: "0.0.0.0:7781", dataDir: "~/.wd", claude: "claude", labels: [], maxThreads: 4, targetDirPool: 4,
    heartbeatSec: 15, tailMs: 1000, pushEverySec: 600, ...c,
  };
  for (const k of ["name", "coordUrl", "token"] as const) if (!cfg[k]) throw new Error(`agent config: "${k}" is required`);
  cfg.dataDir = expand(cfg.dataDir);
  if (cfg.claude.includes("/")) cfg.claude = expand(cfg.claude);
  if (cfg.gitTokenFile) cfg.gitTokenFile = expand(cfg.gitTokenFile);
  return cfg;
}

export interface Ran { ok: boolean; out: string; err: string; code: number | null }
// Never throws: a missing binary or a timeout is an ordinary failed result.
export async function run(cmd: string[], o: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number } = {}): Promise<Ran> {
  try {
    const p = Bun.spawn(cmd, { cwd: o.cwd, env: o.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: o.timeout ?? 60_000 });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { ok: p.exitCode === 0, out: out.trim(), err: err.trim() || (p.signalCode ? `killed by ${p.signalCode}` : ""), code: p.exitCode };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message, code: null };
  }
}

// status 0 means the coordinator could not be reached at all. Without a body it is a GET.
export async function post(cfg: AgentConfig, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch(cfg.coordUrl.replace(/\/$/, "") + path, {
      method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

export const get = (cfg: AgentConfig, path: string) => post(cfg, path);

// The PATH a person gets in a terminal on this host. Tools such as bun and nvm add themselves only in ~/.bashrc or ~/.zshrc,
// which a service's PATH and even a non-interactive login shell never read, so the doctor and every turn would miss them.
// The shell's own PATH comes first, then the service's (where claude is). A marker line, because rc files may print.
export async function loginPath(shell = userInfo().shell || process.env.SHELL || "/bin/bash"): Promise<string> {
  const sh = ["bash", "zsh"].includes(basename(shell)) ? shell : "/bin/bash", own = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const r = await run([sh, "-lic", 'printf "\n__WD_PATH__=%s\n" "$PATH"'], { timeout: 20_000 });
  const found = r.out.split("\n").find((l) => l.startsWith("__WD_PATH__="))?.slice(12);
  return [...new Set([...(found ? found.split(":") : []), ...own.split(":")])].filter(Boolean).join(":");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const lastChars = (s: string, n = 4000) => (s.length > n ? s.slice(-n) : s);
