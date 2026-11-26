// The MCP tools live here, not in `wd mcp`: that process runs as long as its Claude session, so tools defined in the
// coordinator change with a coordinator restart. Each tool maps onto a caller API route.
import type { ThreadView } from "../shared/types";
import { HttpError } from "./scheduler";

const str = { type: "string" };
const tool = (name: string, description: string, props: Record<string, unknown> = {}, required: string[] = []) =>
  ({ name, description, inputSchema: { type: "object" as const, properties: props, required } });

export const TOOLS = [
  tool("wd_submit", "Queue a thread on some host: a Claude Code session, or a pi session when runner is \"pi\" (models like \"deepseek/deepseek-flash\" or \"anthropic/claude-sonnet-5-5:high\"). billing: api (default, the host's envFile keys) or session (the stored subscription login). Returns {id, position} at once; the report arrives on its own when it ends.", {
    repo: str, prompt: str, ref: str, model: str, branch: str, tag: str, requires: { type: "array", items: str },
    runner: { enum: ["claude", "pi"] }, billing: { enum: ["api", "session"] }, size: { enum: ["small", "heavy"] }, priority: { type: "boolean" }, ttlHours: { type: "number" },
  }, ["repo", "prompt"]),
  tool("wd_send", "Queue a follow-up turn on an existing thread.", { thread: str, text: str }, ["thread", "text"]),
  tool("wd_cancel", "Cancel a thread.", { thread: str }, ["thread"]),
  tool("wd_release", "Free a thread's worktree (the branch stays pushed).", { thread: str }, ["thread"]),
  tool("wd_status", "State of one thread, or a one-line summary of this caller's newest 50 threads when no thread is given. Not needed to get results. full: the whole last message, which reports cut at 4000 chars.", { thread: str, full: { type: "boolean" } }),
  tool("wd_hosts", "List hosts and their headroom."),
  tool("wd_inbox", "Unacknowledged reports (backup for channel delivery)."),
  tool("wd_ack", "Acknowledge a report by id.", { id: { type: "number" } }, ["id"]),
];

type Route = { method: string; path: string; body?: unknown; shape?: (v: any) => unknown };
const id = (v: unknown) => encodeURIComponent(String(v ?? ""));

// One line per thread, newest 50: the full views (prompt-sized messages, up to 500 threads) overflow a tool result.
const compact = (all: ThreadView[]) => ({
  threads: all.slice(0, 50).map((t) => ({ id: t.id, tag: t.tag, state: t.state, host: t.host, turns: t.turns, reason: t.reason?.slice(0, 200) ?? null })),
  more: Math.max(all.length - 50, 0), note: "wd_status with a thread id has the details",
});

export function toolRoute(name: string, a: any, caller: string): Route {
  const c = `?caller=${encodeURIComponent(caller)}`;
  switch (name) {
    case "wd_submit": return { method: "POST", path: "/threads", body: { ...a, caller } };
    case "wd_send": return { method: "POST", path: `/threads/${id(a.thread)}/send`, body: { text: a.text } };
    case "wd_cancel": return { method: "POST", path: `/threads/${id(a.thread)}/cancel` };
    case "wd_release": return { method: "POST", path: `/threads/${id(a.thread)}/release` };
    case "wd_status": return a.thread ? { method: "GET", path: `/threads/${id(a.thread)}${a.full ? "?full=1" : ""}` } : { method: "GET", path: `/threads${c}`, shape: compact };
    case "wd_hosts": return { method: "GET", path: "/hosts" };
    case "wd_inbox": return { method: "GET", path: `/reports${c}` };
    case "wd_ack": return { method: "POST", path: `/reports/${id(a.id)}/ack` };
  }
  throw new HttpError(404, `unknown tool ${name}`);
}
