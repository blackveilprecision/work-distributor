// `wd mcp`: stdio MCP server. Tools return at once; reports are pushed as claude/channel events.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ack, call, loadCfg, qs, reportText, type Cfg } from "../cli/client.ts";
import type { Report, ThreadView } from "../shared/types.ts";

const str = { type: "string" };
const tool = (name: string, description: string, props: Record<string, unknown> = {}, required: string[] = []) =>
  ({ name, description, inputSchema: { type: "object" as const, properties: props, required } });
const TOOLS = [
  tool("wd_submit", "Queue a Claude Code thread on some host. Returns {id, position} at once; the report arrives on its own when it ends.", {
    repo: str, prompt: str, ref: str, model: str, branch: str, tag: str, requires: { type: "array", items: str },
    size: { enum: ["small", "heavy"] }, priority: { type: "boolean" }, ttlHours: { type: "number" },
  }, ["repo", "prompt"]),
  tool("wd_send", "Queue a follow-up turn on an existing thread.", { thread: str, text: str }, ["thread", "text"]),
  tool("wd_cancel", "Cancel a thread.", { thread: str }, ["thread"]),
  tool("wd_release", "Free a thread's worktree (the branch stays pushed).", { thread: str }, ["thread"]),
  tool("wd_status", "State of one thread, or a one-line summary of this caller's newest 50 threads when no thread is given. Not needed to get results. full: the whole last message, which reports cut at 4000 chars.", { thread: str, full: { type: "boolean" } }),
  tool("wd_hosts", "List hosts and their headroom."),
  tool("wd_inbox", "Unacknowledged reports (backup for channel delivery)."),
  tool("wd_ack", "Acknowledge a report by id.", { id: { type: "number" } }, ["id"]),
];

const HANDLERS: Record<string, (cfg: Cfg, a: any) => Promise<unknown>> = {
  wd_submit: (cfg, a) => call(cfg, "POST", "/threads", { ...a, caller: cfg.caller }),
  wd_send: (cfg, a) => call(cfg, "POST", `/threads/${a.thread}/send`, { text: a.text }),
  wd_cancel: (cfg, a) => call(cfg, "POST", `/threads/${a.thread}/cancel`),
  wd_release: (cfg, a) => call(cfg, "POST", `/threads/${a.thread}/release`),
  wd_status: (cfg, a) => a.thread ? call(cfg, "GET", `/threads/${a.thread}${a.full ? "?full=1" : ""}`) : list(cfg),
  wd_hosts: (cfg) => call(cfg, "GET", "/hosts"),
  wd_inbox: (cfg) => call(cfg, "GET", `/reports${qs({ caller: cfg.caller })}`),
  wd_ack: (cfg, a) => ack(cfg, a.id),
};

// One line per thread, newest 50: the full views (prompt-sized messages, up to 500 threads) overflow a tool result.
async function list(cfg: Cfg) {
  const all = (await call(cfg, "GET", `/threads${qs({ caller: cfg.caller })}`)) as ThreadView[];
  const rows = all.slice(0, 50).map((t) => ({ id: t.id, tag: t.tag, state: t.state, host: t.host, turns: t.turns, reason: t.reason?.slice(0, 200) ?? null }));
  return { threads: rows, more: Math.max(all.length - 50, 0), note: "wd_status with a thread id has the details" };
}

export function createServer(cfg: Cfg): Server {
  const server = new Server({ name: "wd", version: "0.1.0" }, {
    capabilities: { tools: {}, experimental: { "claude/channel": {} } },
    instructions: "wd runs Claude Code threads on other hosts. Submit with wd_submit and carry on; never poll. " +
      "When a thread ends its report arrives as a <channel source=\"wd\"> event (meta: report, thread, state, kind, tag). " +
      "After acting on a report, call wd_ack with its report id; an unacknowledged report is shown again on your next prompt. " +
      "Threads that end lost, failed or stalled are yours to retry or not. wd_inbox lists reports that were missed.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const h = HANDLERS[req.params.name];
      if (!h) throw new Error(`unknown tool ${req.params.name}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(await h(cfg, req.params.arguments ?? {})) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: String((e as Error).message) }] };
    }
  });
  return server;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => { const t = setTimeout(r, ms); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

// Reconnects forever with backoff. Pushing never acks: Claude Code drops channel events silently when the session was
// started without the channel flag, so acking on push would lose the report. The agent acks with wd_ack,
// and the prompt hook shows whatever is still unacked, so delivery is at least once. Each report is pushed once per process.
export async function streamReports(cfg: Cfg, server: Server, signal: AbortSignal, minMs = 1000, maxMs = 30000) {
  const seen = new Set<number>();
  const deliver = async (r: Report) => {
    if (seen.has(r.id)) return;
    await server.notification({ method: "notifications/claude/channel",
      params: { content: `${reportText(r)}\n(report ${r.id}: call wd_ack once handled)`, meta: { report: String(r.id), thread: r.thread, state: r.state, kind: r.kind, tag: r.tag ?? "" } } });
    seen.add(r.id);
  };
  let delay = minMs;
  while (!signal.aborted) {
    try {
      const res = await fetch(`${cfg.url}/reports/stream${qs({ caller: cfg.caller })}`, {
        headers: { authorization: `Bearer ${cfg.token}`, accept: "text/event-stream" }, signal });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      delay = minMs;
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
        for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
          const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (!data) continue;
          try { await deliver(JSON.parse(data)); } catch (e) { console.error("wd mcp: report not delivered:", (e as Error).message); }
        }
      }
    } catch (e) {
      if (!signal.aborted) console.error("wd mcp: stream:", (e as Error).message);
    }
    await sleep(delay, signal);
    delay = Math.min(delay * 2, maxMs);
  }
}

export async function mcpMain(_args: string[]): Promise<void> {
  const cfg = loadCfg();
  const server = createServer(cfg);
  const ctl = new AbortController();
  server.onclose = () => { ctl.abort(); process.exit(0); };
  await server.connect(new StdioServerTransport());
  process.stdin.on("end", () => process.exit(0));   // the SDK transport does not notice a closed stdin, so the server would linger
  await streamReports(cfg, server, ctl.signal);
}
