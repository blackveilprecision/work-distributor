// `wd mcp`: stdio MCP server. Tools return at once; reports are pushed as claude/channel events.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { call, loadCfg, qs, reportText, type Cfg } from "../cli/client.ts";
import type { Report } from "../shared/types.ts";
import { VERSION } from "../shared/version.ts";

// The tools come from the coordinator (GET /mcp/tools) and run there (POST /mcp/call), so a coordinator restart
// changes them for every open session: when the report stream reconnects, a changed list sends tools/list_changed.
export function createServer(cfg: Cfg): { server: Server; refresh: () => Promise<void> } {
  const server = new Server({ name: "wd", version: VERSION }, {
    capabilities: { tools: { listChanged: true }, experimental: { "claude/channel": {} } },
    instructions: "wd runs Claude Code threads on other hosts. Submit with wd_submit and carry on; never poll. " +
      "When a thread ends its report arrives as a <channel source=\"wd\"> event (meta: report, thread, state, kind, tag). " +
      "After acting on a report, call wd_ack with its report id; an unacknowledged report is shown again on your next prompt. " +
      "Threads that end lost, failed or stalled are yours to retry or not. wd_inbox lists reports that were missed.",
  });
  let tools: unknown[] = [], known = "";
  const load = async () => { tools = ((await call(cfg, "GET", "/mcp/tools")) as { tools: unknown[] }).tools; };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await load().catch((e) => console.error("wd mcp: tools:", (e as Error).message));   // none until the coordinator answers
    known = JSON.stringify(tools);
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const r = await call(cfg, "POST", "/mcp/call", { name: req.params.name, arguments: req.params.arguments ?? {}, caller: cfg.caller });
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: String((e as Error).message) }] };
    }
  });
  const refresh = async () => {
    await load();
    if (known && JSON.stringify(tools) !== known) await server.sendToolListChanged();
  };
  return { server, refresh };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => { const t = setTimeout(r, ms); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

// Reconnects forever with backoff. Pushing never acks: Claude Code drops channel events silently when the session was
// started without the channel flag, so acking on push would lose the report. The agent acks with wd_ack,
// and the prompt hook shows whatever is still unacked, so delivery is at least once. Each report is pushed once per process.
export async function streamReports(cfg: Cfg, server: Server, signal: AbortSignal, minMs = 1000, maxMs = 30000, onConnect = async () => {}) {
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
      await onConnect().catch((e) => console.error("wd mcp: tools:", (e as Error).message));
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
  const { server, refresh } = createServer(cfg);
  const ctl = new AbortController();
  server.onclose = () => { ctl.abort(); process.exit(0); };
  await server.connect(new StdioServerTransport());
  process.stdin.on("end", () => process.exit(0));   // the SDK transport does not notice a closed stdin, so the server would linger
  await streamReports(cfg, server, ctl.signal, undefined, undefined, refresh);
}
