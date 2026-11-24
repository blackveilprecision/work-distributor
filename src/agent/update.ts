// Self-update: the coordinator names its version in each heartbeat reply, and an agent running an older release
// replaces its own binary with that release and exits for systemd or launchd to start the new one. Turns are
// detached processes, so they keep running and the new agent tails them again.
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { newer, releaseUrl, VERSION } from "../shared/version";

const RETRY_MS = 10 * 60 * 1000;
const tried = new Map<string, number>();

// Only a compiled wd replaces itself; an agent run from source has bun as its executable.
export const compiled = (exe = process.execPath) => !/^bun(\.exe)?$/.test(basename(exe));

export function wantUpdate(target: string | undefined, autoUpdate: boolean | undefined, now = Date.now()): target is string {
  if (!target || autoUpdate === false || !compiled() || !newer(target, VERSION)) return false;
  if (now - (tried.get(target) ?? -Infinity) < RETRY_MS) return false;
  tried.set(target, now);
  return true;
}

// Downloads, checks the new binary reports the version, then renames it over `exe` (a new inode, so the running
// image is untouched). Throws without touching `exe` on any failure.
export async function replaceBinary(target: string, exe: string, os: string = process.platform, arch: string = process.arch, base?: string) {
  // About 95 MB, possibly onto a busy host: a generous limit.
  const res = await fetch(releaseUrl(target, os, arch, base), { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const tmp = `${exe}.new`;
  try {
    writeFileSync(tmp, new Uint8Array(await res.arrayBuffer()));
    chmodSync(tmp, 0o755);
    const p = Bun.spawnSync([tmp, "--version"], { stdout: "pipe", stderr: "pipe" });
    const got = p.stdout.toString().trim();
    if (got !== target) throw new Error(`downloaded binary reports ${JSON.stringify(got)}, not ${target}`);
    renameSync(tmp, exe);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
