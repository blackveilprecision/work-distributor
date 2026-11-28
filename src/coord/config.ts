import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

export interface HostCfg { url: string; token: string; labels?: string[]; maxThreads?: number }
export interface RepoCfg { url: string; defaultRef: string; doctor?: string; requires: string[] }
export interface Config {
  listen: string; db: string; callerToken: string;
  hosts: Record<string, HostCfg>; repos: Record<string, RepoCfg>;
  floors: { diskFreePct: number; memReserveMb: number; cpuOversub: number };   // cpuOversub: how far past its cores a host may be committed
  tickMs: number; stallMin: number; lostAfterSec: number;
  asleepLostSec: number; runtimeMaxSec: number;
}

export const expand = (p: string) => (p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p);

export const parseRepo = (r: any): RepoCfg => ({ url: r.url, defaultRef: r.defaultRef ?? "main", doctor: r.doctor, requires: r.requires ?? [] });

export function parseConfig(raw: any): Config {
  if (!raw?.callerToken) throw new Error("coord config: callerToken is required");
  const repos: Config["repos"] = {};
  for (const [id, r] of Object.entries<any>(raw.repos ?? {})) repos[id] = parseRepo(r);
  return {
    listen: raw.listen ?? "127.0.0.1:7780",
    db: expand(raw.db ?? "~/.local/share/wd/wd.sqlite"),
    callerToken: raw.callerToken,
    hosts: raw.hosts ?? {},
    repos,
    floors: { diskFreePct: 15, memReserveMb: 2048, cpuOversub: 1.5, ...raw.floors },
    tickMs: raw.tickMs ?? 5000,
    stallMin: raw.stallMin ?? 20,
    lostAfterSec: raw.lostAfterSec ?? 120,
    asleepLostSec: raw.asleepLostSec ?? 6 * 3600,   // a sleeping Mac resumes its sessions on wake
    runtimeMaxSec: raw.runtimeMaxSec ?? 4 * 3600,
  };
}

export function loadConfig(path = process.env.WD_CONFIG ?? "~/.config/wd/coord.json"): Config {
  if (!existsSync(expand(path))) throw new Error(`coordinator config not found: ${path} (see "wd coord install" or "wd init-local")`);
  return parseConfig(JSON.parse(readFileSync(expand(path), "utf8")));
}
