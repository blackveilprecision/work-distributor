// Coordinator HTTP client shared by the CLI and the MCP server.
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import type { Report } from "../shared/types.ts";

export interface Cfg { url: string; token: string; caller: string }

// WD_CLIENT_CONFIG points at another client.json (a trial instance, a test).
export const clientConfigPath = (env: Record<string, string | undefined> = process.env) =>
  env.WD_CLIENT_CONFIG || join(env.HOME || homedir(), ".config/wd/client.json");

// Empty env values count as unset: the plugin's .mcp.json passes WD_* through as "" when they are not set.
export function loadCfg(env: Record<string, string | undefined> = process.env): Cfg {
  let f: any = {};
  try { f = JSON.parse(readFileSync(clientConfigPath(env), "utf8")); } catch {}
  return {
    url: (env.WD_URL || f.url || "http://127.0.0.1:7780").replace(/\/$/, ""),
    token: env.WD_TOKEN || f.token || "",
    caller: env.WD_CALLER || f.caller || `${hostname().split(".")[0]}:${basename(process.cwd())}`,
  };
}

// A refused connection never reached the coordinator, so even a POST is safe to repeat: this rides out a coordinator restart.
export async function call(cfg: Cfg, method: string, path: string, body?: unknown, timeoutMs = 15000, retryMs = 20000): Promise<any> {
  const until = Date.now() + retryMs;
  let res: Response;
  for (;;) {
    try {
      res = await fetch(cfg.url + path, {
        method,
        headers: { authorization: `Bearer ${cfg.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if ((code !== "ConnectionRefused" && code !== "ECONNREFUSED") || Date.now() >= until) throw e;
      await Bun.sleep(500);
    }
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const qs = (o: Record<string, string | number | undefined>) =>
  "?" + Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

export const ack = (cfg: Cfg, id: number, timeoutMs?: number, retryMs?: number) => call(cfg, "POST", `/reports/${id}/ack`, undefined, timeoutMs, retryMs);

// One compact text block per report, used as channel content and as hook context.
export function reportText(r: Report): string {
  const head = [`wd ${r.kind} report: thread ${r.thread}`, r.tag && `tag=${r.tag}`, `state=${r.state}`, r.host && `host=${r.host}`,
    r.isError && "is_error", `branch=${r.branch}`, r.head && `head=${r.head.slice(0, 12)}`, r.pushed && "pushed",
    `cost=$${r.turnCostUsd.toFixed(2)}`, `${Math.round(r.turnSeconds)}s`].filter(Boolean).join(" ");
  return [head, r.reason && `reason: ${r.reason}`, r.message,
    r.truncated && `[message cut at 4000 chars: \`wd status ${r.thread} --full\` (wd_status with full) has the whole text]`].filter(Boolean).join("\n");
}
