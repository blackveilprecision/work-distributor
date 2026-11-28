// Mirror, worktrees, pushing and build output. All git runs with a fixed env so a host's own git config
// or askpass prompts can never hang a turn.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { StartTurn } from "../shared/types";
import { type AgentConfig, run, type Ran } from "./config";

const flat = (repoId: string) => repoId.replaceAll("/", "__");
export const mirrorPath = (cfg: AgentConfig, repoId: string) => join(cfg.dataDir, "repos", flat(repoId) + ".git");
export const wtPath = (cfg: AgentConfig, thread: string) => join(cfg.dataDir, "wt", thread);

// The token is read by a one-shot helper on the command line, so it is never written to any git config (the worker, being
// the same user, could still read the token file itself). The empty
// first helper clears whatever the host configured (a keyring that is gone after a reboot).
export function authArgs(cfg: AgentConfig): string[] {
  if (!cfg.gitTokenFile) return [];
  const helper = `!f() { echo username=x-access-token; echo "password=$(cat '${cfg.gitTokenFile}')"; }; f`;
  return ["-c", "credential.helper=", "-c", `credential.helper=${helper}`];
}
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
// The worktree's own git identity (repo, global or system config) authors the end-of-turn commit, as it does the
// worker's commits; wd's is only a fallback for a host with none, where git would refuse to commit.
const ident = async (cfg: AgentConfig, wt: string) => {
  const has = async (k: string) => !!(await git(cfg, wt, ["config", "--get", k])).out.trim();
  return [...(await has("user.name")) ? [] : ["-c", "user.name=wd"], ...(await has("user.email")) ? [] : ["-c", "user.email=wd@localhost"]];
};
export const git = (cfg: AgentConfig, cwd: string, args: string[], auth = false, timeout = 300_000): Promise<Ran> =>
  run(["git", ...(auth ? authArgs(cfg) : []), ...args], { cwd, env: gitEnv, timeout });

// One git operation at a time per repo mirror: two threads starting together must not fetch or clone at once.
const chains = new Map<string, Promise<unknown>>();
function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(key, next.catch(() => {}));
  return next;
}

export function ensureMirror(cfg: AgentConfig, repoId: string, url: string): Promise<string> {
  const dir = mirrorPath(cfg, repoId);
  return exclusive(dir, async () => {
    if (!existsSync(dir)) {
      mkdirSync(join(cfg.dataDir, "repos"), { recursive: true });
      const c = await git(cfg, cfg.dataDir, ["clone", "--mirror", url, dir], true);
      if (!c.ok) throw new Error(`clone ${url} failed: ${c.err}`);
      // A mirror config would make every push a mirror push and every fetch overwrite the work branches; keep the
      // origin branches under refs/remotes/origin so the push lease has something to compare with.
      await git(cfg, dir, ["config", "--unset", "remote.origin.mirror"]);
      await git(cfg, dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    }
    const f = await git(cfg, dir, ["fetch", "--prune", "origin"], true);
    if (!f.ok) throw new Error(`fetch failed: ${f.err}`);
    return dir;
  });
}

async function resolveRef(cfg: AgentConfig, dir: string, ref: string): Promise<string> {
  for (const name of [`refs/remotes/origin/${ref}`, ref]) {
    const r = await git(cfg, dir, ["rev-parse", "--verify", "-q", `${name}^{commit}`]);
    if (r.ok) return r.out;
  }
  throw new Error(`ref ${ref} not found`);
}

// A fresh turn gets a new worktree on the work branch; a resume reuses the existing one.
export async function prepareWorktree(cfg: AgentConfig, s: StartTurn): Promise<string> {
  const wt = wtPath(cfg, s.thread);
  if (existsSync(wt)) return wt;
  if (s.resume) throw new Error(`worktree for ${s.thread} is gone, cannot resume`);
  const mirror = await ensureMirror(cfg, s.repoId, s.repoUrl);
  const base = await resolveRef(cfg, mirror, s.ref);
  mkdirSync(join(cfg.dataDir, "wt"), { recursive: true });
  const w = await git(cfg, mirror, ["worktree", "add", "-q", "-B", s.branch, wt, base]);
  if (!w.ok) throw new Error(`worktree add failed: ${w.err}`);
  writeFileSync(wt + ".base", base);
  mkdirSync(join(wt, ".wd-tmp"), { recursive: true });
  const ex = resolve(wt, (await git(cfg, wt, ["rev-parse", "--git-path", "info/exclude"])).out);
  mkdirSync(dirname(ex), { recursive: true });
  const cur = existsSync(ex) ? readFileSync(ex, "utf8") : "";   // shared by every worktree of the mirror: add the line once
  if (!cur.split("\n").includes(".wd-tmp")) writeFileSync(ex, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + ".wd-tmp\n");
  return wt;
}

export interface Pushed { head: string | null; pushed: boolean; pushError: string | null }
// Pushes only when the branch is ahead of where it started. At the end of a turn leftovers are committed first; during
// a turn nothing is committed, because the worker is using git at that moment.
export async function pushWork(cfg: AgentConfig, thread: string, branch: string, commit: boolean): Promise<Pushed> {
  const wt = wtPath(cfg, thread);
  if (!existsSync(wt)) return { head: null, pushed: false, pushError: "worktree missing" };
  if (commit && (await git(cfg, wt, ["status", "--porcelain"])).out) {
    await git(cfg, wt, ["add", "-A"]);
    await git(cfg, wt, [...(await ident(cfg, wt)), "commit", "-q", "--no-verify", "-m", "wd: uncommitted work at end of turn"]);
  }
  const head = (await git(cfg, wt, ["rev-parse", "HEAD"])).out || null;
  const base = existsSync(wt + ".base") ? readFileSync(wt + ".base", "utf8").trim() : "";
  const ahead = Number((await git(cfg, wt, ["rev-list", "--count", `${base}..HEAD`])).out || 0);
  if (!head || ahead === 0) return { head, pushed: false, pushError: null };
  const p = await git(cfg, wt, ["push", "--force-with-lease", "origin", branch], true);
  return { head, pushed: p.ok, pushError: p.ok ? null : p.err.slice(-1000) };
}

export async function releaseWorktree(cfg: AgentConfig, thread: string): Promise<void> {
  const wt = wtPath(cfg, thread);
  // The worktree knows its mirror, so a release needs no repo id.
  const common = existsSync(wt) ? (await git(cfg, wt, ["rev-parse", "--git-common-dir"])).out : "";
  const mirror = common ? resolve(wt, common) : null;
  if (mirror) await git(cfg, mirror, ["worktree", "remove", "--force", wt]);
  rmSync(wt, { recursive: true, force: true });
  rmSync(wt + ".base", { force: true });
  if (mirror) await git(cfg, mirror, ["worktree", "prune"]);
}

// Build output left in the worktree (cargo's target/, for one) can take gigabytes, and a worktree stays a day after its
// last turn. It goes when a turn ends: a follow-up rebuilds it, from the host's compiler cache when it has one.
export function dropBuildOutput(wt: string) {
  if (existsSync(join(wt, "target"))) rmSync(join(wt, "target"), { recursive: true, force: true });
}
