// In-process stand-in for the coordinator's caller API.
import type { Report } from "../../src/shared/types.ts";
import { TOOLS, toolRoute } from "../../src/coord/tools.ts";

export const rep = (id: number, over: Partial<Report> = {}): Report => ({
  id, caller: "t:x", thread: `th${id}`, tag: "job", kind: "final", state: "done", host: "box1", isError: false,
  message: "all good", branch: `wd/th${id}`, head: "abcdef1234567890", pushed: true, turnCostUsd: 0.5, turnSeconds: 61,
  reason: null, truncated: false, createdAt: 1, ...over,
});

export function fakeCoord(token = "tok") {
  const reqs: { method: string; path: string; body: any; auth: string | null }[] = [];
  const acked: number[] = [];
  const pending: Report[] = [];
  const streams: ReadableStreamDefaultController[] = [];
  let streamHits = 0;
  let dropFirstStream = false;
  const tools = { list: TOOLS as unknown[] };
  const enc = new TextEncoder();
  const sse = (c: ReadableStreamDefaultController, r: Report) => c.enqueue(enc.encode(`data: ${JSON.stringify(r)}\n\n`));

  async function fetch(req: Request): Promise<Response> {
      const u = new URL(req.url);
      const body = req.method === "POST" || req.method === "PUT" ? await req.json().catch(() => undefined) : undefined;
      reqs.push({ method: req.method, path: u.pathname + u.search, body, auth: req.headers.get("authorization") });
      if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("no", { status: 401 });
      if (u.pathname === "/reports/stream") {
        streamHits++;
        let ctl!: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) {
            ctl = c;
            c.enqueue(enc.encode(": hello\n\n"));
            for (const r of pending.filter((r) => !acked.includes(r.id))) sse(c, r);
            if (dropFirstStream && streamHits === 1) c.close(); else streams.push(c);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (u.pathname === "/mcp/tools") return Response.json({ version: "0", tools: tools.list });
      if (u.pathname === "/mcp/call") {   // the real coordinator's routing, run against this fake's routes
        const r = toolRoute(body.name, body.arguments, body.caller);
        const res = await fetch(new Request(new URL(r.path, u), { method: r.method, headers: { authorization: `Bearer ${token}` }, body: r.body ? JSON.stringify(r.body) : undefined }));
        if (!res.ok) return res;
        const v = await res.json();
        return Response.json(r.shape ? r.shape(v) : v);
      }
      const ackM = u.pathname.match(/^\/reports\/(\d+)\/ack$/);
      if (ackM) { acked.push(Number(ackM[1])); return Response.json({ ok: true }); }
      if (u.pathname === "/reports") return Response.json(pending.filter((r) => !acked.includes(r.id)));
      if (u.pathname === "/threads" && req.method === "POST") return Response.json({ id: "th1", position: 0 });
      if (u.pathname === "/threads") return Response.json(Array.from({ length: 60 }, (_, i) =>
        ({ id: `t${i}`, tag: null, state: "done", host: "box1", turns: 1, reason: null, prompt: "p".repeat(5000), lastMessage: "m".repeat(4000) })));
      if (u.pathname === "/hosts") return Response.json([]);
      if (u.pathname === "/repos" && req.method === "GET") return Response.json([{ id: "acme/shop", url: "u", defaultRef: "main", doctor: "true", requires: ["gpu"], source: "db" }]);
      if (u.pathname.startsWith("/repos/")) return Response.json({ ...body, source: u.pathname.endsWith("o%2Fcfg") ? "config" : "db" });
      return Response.json({ path: u.pathname, body });
  }
  const server = Bun.serve({ port: 0, fetch });
  return {
    url: `http://127.0.0.1:${server.port}`, token, reqs, acked, pending, tools,
    dropFirstStream() { dropFirstStream = true; },
    push(r: Report) { pending.push(r); for (const c of streams) sse(c, r); },
    stop() { server.stop(true); },
  };
}

export const until = async (f: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await Bun.sleep(10); }
};
