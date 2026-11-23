import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentThreads, EventsBatch, Heartbeat, HostState, HostView, Report, SubmitRequest, TurnEnd } from "../shared/types";
import { parseRepo, type Config } from "./config";
import { threadView } from "./db";
import { threadSteps } from "./steps";
import type { Reports } from "./reports";
import { HttpError, type Scheduler } from "./scheduler";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (v: unknown, status = 200) => Response.json(v, { status });
const NAME = /^\w[\w.-]*$/, REPO_ID = /^\w[\w.-]*(\/\w[\w.-]*)*$/;

export function hostViews(s: Scheduler, repo?: string): HostView[] {
  return Object.entries(s.hostCfgs()).map(([name, c]) => {
    const row = s.db.host(name), why = repo ? { why: s.eligibility(repo, name) } : {};
    const doctorFailed = s.db.all<{ repo: string }>("SELECT repo FROM doctor WHERE host=? AND ok=0 ORDER BY repo", name).map((d) => d.repo).filter((r) => s.repo(r));
    if (!row) {
      return { name, os: "linux", state: "lost" as HostState, reason: "never seen", labels: c.labels ?? [], cores: 0, memTotalMb: 0, memAvailMb: 0,
        diskFreePct: 0, running: 0, maxThreads: c.maxThreads ?? 4, claudeVersion: null, loginExpiresAt: null, lastSeenAt: null, doctorFailed, ...why };
    }
    const hb = JSON.parse(row.hb) as Heartbeat, p = hb.probe;
    return { name, os: p.os, state: row.state as HostState, reason: row.reason, labels: hb.labels ?? c.labels ?? [], cores: p.cores,
      memTotalMb: p.memTotalMb, memAvailMb: p.memAvailMb, diskFreePct: p.diskFreePct, running: s.db.runningOn(name), maxThreads: s.maxThreads(row),
      claudeVersion: p.claudeVersion, loginExpiresAt: p.loginExpiresAt, lastSeenAt: row.seen, doctorFailed, ...why };
  });
}

function stream(reports: Reports, caller: string, after: number) {
  const enc = new TextEncoder(), seen = new Set<number>();
  let unsub = () => {}, timer: ReturnType<typeof setInterval>;
  const body = new ReadableStream({
    start(c) {
      const send = (r: Report) => { if (!seen.has(r.id)) { seen.add(r.id); c.enqueue(enc.encode(`id: ${r.id}\ndata: ${JSON.stringify(r)}\n\n`)); } };
      unsub = reports.subscribe(caller, send);   // before the backlog, so nothing falls in the gap
      for (const r of reports.pending(caller, after)) send(r);
      timer = setInterval(() => c.enqueue(enc.encode(": keepalive\n\n")), 15_000);
    },
    cancel() { unsub(); clearInterval(timer); },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

export function makeHandler(s: Scheduler, reports: Reports) {
  const cfg: Config = s.cfg;
  const bearer = (req: Request) => (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");

  async function agentRoute(path: string, req: Request, body: any, url: URL) {
    const host: string | undefined = body?.host ?? url.searchParams.get("host") ?? undefined;   // a GET has no body
    const h = host ? s.hostCfg(host) : undefined;
    if (!h || !same(bearer(req), h.token)) throw new HttpError(401, "bad host token");
    if (path === "/agent/heartbeat") return json(s.onHeartbeat(body as Heartbeat));
    if (path === "/agent/events") {
      const ack = s.onEvents(body as EventsBatch);
      return ack ? json(ack) : json({ error: "stale epoch" }, 409);
    }
    if (path === "/agent/turn-end") return s.onTurnEnd(body as TurnEnd) ? json({ ok: true }) : json({ error: "stale epoch" }, 409);
    if (req.method === "GET" && path === "/agent/threads") return json({ threads: s.liveThreads(host!) } satisfies AgentThreads);
    throw new HttpError(404, "not found");
  }

  async function callerRoute(method: string, path: string, url: URL, body: any) {
    const caller = url.searchParams.get("caller");
    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/threads") return json(s.submit(body as SubmitRequest), 201);
    if (method === "GET" && path === "/threads") return json(s.views(caller));
    if ((m = path.match(/^\/threads\/([\w-]+)(?:\/(send|cancel|release|steps))?$/))) {
      const [, id, act] = m;
      if (method === "GET" && act === "steps") {
        const num = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
        const r = threadSteps(s.db, s.get(id).id, { turn: num("turn"), n: Math.min(num("n") ?? 20, 500), after: num("after") });
        if (!r) throw new HttpError(404, "no such turn");
        return json(r);
      }
      if (method === "GET" && !act) {
        const v = threadView(s.get(id));
        // last_message and reports are cut at 4000 chars; the turn keeps the whole text.
        if (url.searchParams.get("full")) {
          v.messages = s.db.all<{ n: number; result: string }>("SELECT n, result FROM turns WHERE thread=? AND result IS NOT NULL ORDER BY n", id).map((u) => ({ turn: u.n, text: u.result }));
          v.lastMessage = v.messages.at(-1)?.text ?? v.lastMessage;
        }
        return json(v);
      }
      if (method === "POST" && act === "send") return json(s.send(id, body?.text), 202);
      if (method === "POST" && act === "cancel") return json(threadView(await s.cancel(id)));
      if (method === "POST" && act === "release") return json(threadView(await s.release(id)));
    }
    if (method === "GET" && path === "/reports") return json(reports.pending(caller, Number(url.searchParams.get("after") ?? 0)));
    if (method === "GET" && path === "/reports/stream") {
      if (!caller) throw new HttpError(400, "caller is required");
      return stream(reports, caller, Number(url.searchParams.get("after") ?? 0));
    }
    if (method === "POST" && (m = path.match(/^\/reports\/(\d+)\/ack$/))) return json({ ok: reports.ack(Number(m[1])) });
    if (method === "PUT" && (m = path.match(/^\/callers\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]), webhook = body?.webhook ?? null;
      s.db.run("INSERT OR REPLACE INTO callers(name,webhook) VALUES(?,?)", name, webhook);
      return json({ name, webhook });
    }
    if (method === "GET" && path === "/hosts") {
      const repo = url.searchParams.get("repo") ?? undefined;
      if (repo && !s.repo(repo)) throw new HttpError(404, `unknown repo ${repo}`);
      return json(hostViews(s, repo));
    }
    if (method === "GET" && path === "/queue") return json(s.queue(hostViews(s)));
    if (method === "PUT" && (m = path.match(/^\/hosts\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]), url = String(body?.url ?? "").replace(/\/$/, "");
      if (!NAME.test(name)) throw new HttpError(400, "bad host name");
      if (!/^https?:\/\/\S+$/.test(url)) throw new HttpError(400, "url is required (the agent's http://host:7781)");
      const cur = s.hostCfg(name);
      if (cfg.hosts[name]) return json({ name, url: cfg.hosts[name].url, source: "config" });   // coord.json wins; its token is never returned
      // A token is handed out only when it is created or rotated here: reading an existing one back would let any caller-token holder take over a host.
      const fresh = !cur || !!body?.rotate, token = fresh ? randomBytes(24).toString("hex") : cur!.token;
      s.db.run("INSERT OR REPLACE INTO reg_hosts(name,url,token) VALUES(?,?,?)", name, url, token);
      return json({ name, url, ...(fresh ? { token } : {}), source: "db" });
    }
    if (method === "DELETE" && (m = path.match(/^\/hosts\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]);
      if (cfg.hosts[name]) throw new HttpError(409, "host is defined in coord.json");
      if (!s.hostCfg(name)) throw new HttpError(404, "no such host");
      if (s.db.runningOn(name)) throw new HttpError(409, "host has running threads");
      s.db.tx(() => { for (const t of ["reg_hosts", "hosts"]) s.db.run(`DELETE FROM ${t} WHERE name=?`, name); s.db.run("DELETE FROM doctor WHERE host=?", name); });
      return json({ ok: true });
    }
    if (method === "GET" && path === "/repos") return json(Object.entries(s.repos()).map(([id, r]) => ({ id, ...r, source: cfg.repos[id] ? "config" : "db" })));
    if (method === "PUT" && (m = path.match(/^\/repos\/(.+)$/))) {
      const id = decodeURIComponent(m[1]);
      if (!REPO_ID.test(id)) throw new HttpError(400, "bad repo id (owner/name)");
      if (typeof body?.url !== "string" || !body.url) throw new HttpError(400, "url is required");
      const repo = parseRepo(body);
      if (cfg.repos[id]) return json({ id, ...cfg.repos[id], source: "config" });   // coord.json wins
      s.db.tx(() => { s.db.run("INSERT OR REPLACE INTO reg_repos(id,spec) VALUES(?,?)", id, JSON.stringify(repo)); s.db.run("DELETE FROM doctor WHERE repo=?", id); });
      return json({ id, ...repo, source: "db" });
    }
    if (method === "DELETE" && (m = path.match(/^\/repos\/(.+)$/))) {
      const id = decodeURIComponent(m[1]);
      if (cfg.repos[id]) throw new HttpError(409, "repo is defined in coord.json");
      if (!s.repo(id)) throw new HttpError(404, "no such repo");
      s.db.run("DELETE FROM reg_repos WHERE id=?", id);
      return json({ ok: true });
    }
    throw new HttpError(404, "not found");
  }

  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url), path = url.pathname;
      if (path === "/healthz") return json({ ok: true });
      const body = req.method === "POST" || req.method === "PUT" ? await req.json().catch(() => ({})) : {};
      if (path.startsWith("/agent/")) return await agentRoute(path, req, body, url);
      if (!same(bearer(req), cfg.callerToken)) throw new HttpError(401, "bad token");
      return await callerRoute(req.method, path, url, body);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("api error:", e);
      return json({ error: "internal error" }, 500);
    }
  };
}

export function startApi(s: Scheduler, reports: Reports) {
  const [hostname, port] = [s.cfg.listen.slice(0, s.cfg.listen.lastIndexOf(":")), Number(s.cfg.listen.slice(s.cfg.listen.lastIndexOf(":") + 1))];
  return Bun.serve({ hostname, port, idleTimeout: 255, fetch: makeHandler(s, reports) });
}
