import { FINAL } from "../shared/types";
import type {
  DoctorRequest, DoctorResult, EventsAck, EventsBatch, Heartbeat, HeartbeatReply, Release, Report, StartTurn,
  StopTurn, SubmitRequest, SubmitResponse, ThreadState, TurnEnd, HostView, QueueView,
} from "../shared/types";
import type { Config, HostCfg, RepoCfg } from "./config";
import { Db, threadView, type HostRow, type ThreadRow } from "./db";
import type { Reports } from "./reports";
import { steps } from "./steps";

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// What the coordinator needs from an agent; tests inject a fake.
export interface AgentClient {
  start(host: string, b: StartTurn): Promise<{ ok: boolean; error?: string }>;   // throws when unreachable
  stop(host: string, b: StopTurn): Promise<void>;
  release(host: string, b: Release): Promise<void>;
  doctor(host: string, b: DoctorRequest): Promise<DoctorResult>;
}

export function httpAgent(hostCfg: (name: string) => HostCfg | undefined): AgentClient {
  const call = async (host: string, path: string, body: unknown, ms: number) => {
    const h = hostCfg(host);
    if (!h) throw new Error(`unknown host ${host}`);
    return fetch(h.url + path, {
      method: "POST", headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
    });
  };
  const must = async (r: Response) => { if (!r.ok) throw new Error(`agent ${r.status}: ${(await r.text()).slice(0, 300)}`); };
  return {
    async start(host, b) {
      const r = await call(host, "/start", b, 30_000);
      if (r.ok) return { ok: true };
      const error = (await r.text()).slice(0, 2000);
      if (r.status >= 500) throw new Error(`agent ${r.status}: ${error}`);
      return { ok: false, error: error || `agent rejected start (${r.status})` };
    },
    async stop(host, b) { await must(await call(host, "/stop", b, 10_000)); },
    async release(host, b) { await must(await call(host, "/release", b, 60_000)); },
    async doctor(host, b) { const r = await call(host, "/doctor", b, 180_000); await must(r.clone()); return r.json() as Promise<DoctorResult>; },
  };
}

const DAY = 86_400_000;
const DEFAULT_MB = { small: 2048, heavy: 8192 };
const RESUME_PROMPT = "You were interrupted by a host restart. Continue where you left off.";
const ISFINAL = (s: string) => FINAL.includes(s as ThreadState);

// The scheduler and the state transitions the API triggers live together so every
// change to a thread goes through the same few helpers (finish, launch).
export class Scheduler {
  private busy = false;
  private docWork = new Set<Promise<unknown>>();
  private docKeys = new Set<string>();
  constructor(public db: Db, public cfg: Config, public agent: AgentClient, public reports: Reports, public now: () => number = Date.now) {}

  // Hosts and repos: coord.json entries plus the ones registered through the API. Read on every use, so a registration takes effect at once; coord.json wins on a clash.
  hostCfgs(): Record<string, HostCfg> { return { ...this.db.regHosts(), ...this.cfg.hosts }; }
  hostCfg(name: string): HostCfg | undefined { const h = this.hostCfgs(); return Object.hasOwn(h, name) ? h[name] : undefined; }
  repos(): Record<string, RepoCfg> { return { ...this.db.regRepos(), ...this.cfg.repos }; }
  repo(id: string): RepoCfg | undefined { const r = this.repos(); return Object.hasOwn(r, id) ? r[id] : undefined; }

  // ---- caller operations ----
  submit(r: SubmitRequest): SubmitResponse {
    if (!r?.caller || typeof r.caller !== "string") throw new HttpError(400, "caller is required");
    if (!r.prompt || typeof r.prompt !== "string") throw new HttpError(400, "prompt is required");
    const repo = this.repo(r.repo);
    if (!repo) throw new HttpError(400, `unknown repo ${r.repo}`);
    const id = crypto.randomUUID().slice(0, 8), t = this.now(), pr = r.priority ? 1 : 0;
    this.db.run(
      `INSERT INTO threads(id,caller,repo,ref,branch,tag,prompt,model,requires,size,priority,ttl_hours,state,session_id,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
      id, r.caller, r.repo, r.ref ?? repo.defaultRef, r.branch ?? `wd/${id}`, r.tag ?? null, r.prompt, r.model ?? null,
      JSON.stringify(r.requires ?? []), r.size ?? null, pr, r.ttlHours ?? 24, crypto.randomUUID(), t, t);
    const ahead = this.db.get<{ c: number }>(
      "SELECT COUNT(*) c FROM threads WHERE state='queued' AND (priority>? OR (priority=? AND created<=?))", pr, pr, t)!.c;
    return { id, position: ahead };
  }

  get(id: string) {
    const t = this.db.thread(id);
    if (!t) throw new HttpError(404, "no such thread");
    return t;
  }

  send(id: string, text: string) {
    const t = this.get(id);
    if (!text) throw new HttpError(400, "text is required");
    if (t.state !== "running" && t.state !== "idle") throw new HttpError(409, `cannot send to a ${t.state} thread`);
    this.db.run("INSERT INTO sends(thread,text,created) VALUES(?,?,?)", id, text, this.now());
    return { queued: this.db.get<{ c: number }>("SELECT COUNT(*) c FROM sends WHERE thread=?", id)!.c };
  }

  async cancel(id: string) {
    const t = this.get(id);
    if (ISFINAL(t.state)) return t;
    if (t.state === "running") await this.kill(t, "killed");
    this.finish(id, "cancelled", "cancelled by caller");
    return this.get(id);
  }

  async release(id: string) {
    const t = this.get(id);
    if (t.state === "queued" || t.state === "running") throw new HttpError(409, `cancel a ${t.state} thread instead`);
    if (t.state === "idle") this.finish(id, "done", null, {}, false);   // the caller asked for it: no report to ack
    await this.free(this.get(id));
    return this.get(id);
  }

  // ---- agent operations ----
  // What the agent's orphan sweep must keep: every thread that is not final whatever its host (a queued one may start here
  // again, on a worktree an earlier abandoned start left behind), and this host's final threads whose release has not gone through.
  liveThreads(host: string): string[] {
    return this.db.all<{ id: string }>(
      `SELECT id FROM threads WHERE state NOT IN (${FINAL.map((s) => `'${s}'`).join(",")}) OR (host=? AND released=0)`, host).map((r) => r.id);
  }

  onHeartbeat(hb: Heartbeat): HeartbeatReply {
    const now = this.now(), prev = this.db.host(hb.host), p = hb.probe;
    const reason = p.problems.length ? p.problems.join("; ") : !p.loginOk ? (p.loginError ?? "not logged in") : null;
    const state = reason ? "refused" : "ok";
    this.db.run("INSERT OR REPLACE INTO hosts(name,hb,seen,state,reason,since) VALUES(?,?,?,?,?,?)",
      hb.host, JSON.stringify(hb), now, state, reason, prev?.state === state ? prev.since : now);
    if (prev && (prev.state === "asleep" || prev.state === "lost")) {
      // The silence was not the session's fault: restart the stall clock and clear the asleep note.
      this.db.run("UPDATE turns SET last_activity=? WHERE ended IS NULL AND host=?", now, hb.host);
      this.db.run("UPDATE threads SET reason=NULL WHERE host=? AND state='running' AND reason='host-asleep'", hb.host);
    }
    const stop: StopTurn[] = [];
    for (const u of hb.units) {
      if (!u.running) continue;
      const t = this.db.thread(u.thread);
      if (!t || t.host !== hb.host || t.epoch !== u.epoch || t.state !== "running") { stop.push({ thread: u.thread, epoch: u.epoch }); continue; }
      const cur = this.db.turn(u.thread, u.turn);
      if (!cur || cur.ended) continue;
      this.db.run("UPDATE turns SET mem_peak=MAX(mem_peak,?), cpu_ms=?, last_activity=? WHERE thread=? AND n=?",
        u.memPeakMb, u.cpuMs, u.cpuMs !== cur.cpu_ms ? now : cur.last_activity, u.thread, u.turn);
    }
    return { stop };
  }

  // null means the epoch is stale (HTTP 409).
  onEvents(b: EventsBatch): EventsAck | null {
    const t = this.db.thread(b.thread), u = this.db.turn(b.thread, b.turn);
    if (!t || !u || u.epoch !== b.epoch || t.host !== b.host) return null;
    if (t.epoch !== b.epoch) return null;   // cancelled, stalled or lost: the epoch moved on and the agent must stop
    if (u.ended) return { committed: u.committed };
    if (t.state !== "running") return null;
    // Only a batch that starts exactly at the committed offset is taken. A gap, a repeat, or an overlap (a resend after
    // a lost reply, now with more lines) is answered with where to resume, so no line is ever skipped.
    if (b.offset !== u.committed || b.nextOffset <= u.committed) return { committed: u.committed };
    this.db.tx(() => {
      this.db.run(`INSERT OR IGNORE INTO events(thread,turn,"offset",next_offset,line,at) VALUES(?,?,?,?,?,?)`, b.thread, b.turn, b.offset, b.nextOffset, JSON.stringify(b.lines), this.now());
      this.db.run("UPDATE turns SET committed=?, last_activity=? WHERE thread=? AND n=?", b.nextOffset, this.now(), b.thread, b.turn);
    });
    for (const l of b.lines) if (l.includes("rate_limit_event")) this.rateLimit(t, l);
    return { committed: b.nextOffset };
  }

  private rateLimit(t: ThreadRow, line: string) {
    try {
      const ev = JSON.parse(line), info = ev.rate_limit_info ?? ev;
      if (ev.type !== "rate_limit_event" || info.status !== "rejected") return;
      let at = Number(info.resetsAt ?? info.resets_at ?? 0);
      if (!at) at = this.now() + 300_000;
      else if (at < 1e12) at *= 1000;
      if (at <= Number(this.db.meta("hold_until") ?? 0)) return;
      this.db.setMeta("hold_until", String(at));
      this.db.setThread(t.id, { reason: `rate-limit hold until ${new Date(at).toISOString()}` });
      this.reports.add(t.id, "turn", { reason: `rate-limit: new starts held until ${new Date(at).toISOString()}` });
    } catch { /* a truncated line is not worth a crash */ }
  }

  // false means the epoch is stale (HTTP 409). A repeat of an applied turn-end is accepted and ignored.
  onTurnEnd(b: TurnEnd): boolean {
    const t = this.db.thread(b.thread), u = this.db.turn(b.thread, b.turn);
    if (!t || !u || u.epoch !== b.epoch || t.host !== b.host) return false;
    if (u.ended) return true;
    if (t.epoch !== b.epoch || t.state !== "running") return false;
    const now = this.now(), r = b.result, total = Math.max(t.cost, r?.totalCostUsd ?? 0);
    // Wall time: claude's duration_ms leaves out time spent in tools.
    const cost = total - t.cost, secs = (now - u.started) / 1000;
    this.db.run("UPDATE turns SET ended=?, kind=?, cost=?, mem_peak=?, result=? WHERE thread=? AND n=?",
      now, b.kind, cost, b.kind === "oom" ? Math.max(b.memPeakMb, u.mem_max) : b.memPeakMb, r?.text ?? null, b.thread, b.turn);
    this.db.setThread(b.thread, { head: b.head ?? t.head, cost: total, last_message: r?.text ? r.text.slice(0, 4000) : t.last_message });
    const o: Partial<Report> = { message: r?.text ?? null, pushed: b.pushed, head: b.head ?? t.head, turnCostUsd: cost, turnSeconds: secs };
    const tail = b.stderrTail.slice(-1000);
    if (b.kind === "lost") {
      // The process vanished without an exit file (host reboot), and the epoch is current, so this is not an agent restart
      // (units survive that). Resume once on the same host through the normal sends path, which waits for the host to be
      // ok; a vanished resume turn means something other than a reboot is wrong.
      if (this.db.turn(b.thread, b.turn - 1)?.kind === "lost") { this.finish(b.thread, "lost", "lost twice", o); return true; }
      this.db.setThread(b.thread, { state: "idle", idle_at: now, reason: "host-restart: resuming" });
      this.db.run("INSERT INTO sends(thread,text,created) VALUES(?,?,?)", b.thread, RESUME_PROMPT, now);
      this.reports.add(b.thread, "turn", { ...o, reason: "host-restart: resuming" });
      return true;
    }
    if (b.kind === "exited" && r) {
      const reason = r.isError ? (tail || "claude reported is_error") : b.pushError ? `push failed: ${b.pushError}` : null;
      this.db.setThread(b.thread, { state: "idle", idle_at: now, reason });
      this.reports.add(b.thread, "turn", { ...o, isError: r.isError, reason });
      return true;
    }
    // The cap is per turn, so an oom says nothing about the host's free memory; name the cap and what was running.
    const last = b.kind === "oom" ? steps(this.db, b.thread, b.turn, { n: 1, results: false }).steps[0]?.text : undefined;
    const oom = `oom: the turn reached its ${u.mem_max} MB memory cap (2x its ${u.est_mb} MB estimate; the host's free memory is not the limit)`
      + (last ? `; running: ${last}` : "") + (tail ? `; ${tail}` : "");
    const fail: Record<string, [ThreadState, string]> = {
      exited: ["failed", `exit ${b.exitCode} without a result: ${tail}`], oom: ["failed", oom],
      timeout: ["failed", "cap: runtime limit reached"], killed: ["failed", "killed"],
      "launch-failed": ["failed", tail || "launch failed"],
    };
    const [state, reason] = fail[b.kind] ?? ["failed", b.kind];
    this.finish(b.thread, state, reason, o);
    return true;
  }

  // ---- state helpers ----
  private finish(id: string, state: ThreadState, reason: string | null, o: Partial<Report> = {}, report = true) {
    this.db.setThread(id, { state, reason, final_at: this.now() });
    this.db.run("DELETE FROM sends WHERE thread=?", id);
    if (report) this.reports.add(id, "final", { isError: state !== "done" && state !== "cancelled", reason, ...o });
  }

  // Bumping the epoch makes whatever the agent still reports for this turn stale.
  private async kill(t: ThreadRow, kind: string) {
    this.db.run("UPDATE turns SET ended=?, kind=? WHERE thread=? AND ended IS NULL", this.now(), kind, t.id);
    this.db.setThread(t.id, { epoch: t.epoch + 1 });
    if (t.host) await this.agent.stop(t.host, { thread: t.id, epoch: t.epoch }).catch(() => {});
  }

  private async free(t: ThreadRow) {
    if (t.released || !t.host) return;
    try {
      await this.agent.release(t.host, { thread: t.id });
      this.db.setThread(t.id, { released: 1 });
    } catch { /* retried by cleanup */ }
  }

  // The size hint is a floor: light turns of a repo must not shrink a heavy thread's estimate, and with it its memory cap
  // (2x the estimate), to a few hundred MB.
  private estimate(t: Pick<ThreadRow, "repo" | "size">): number {
    const rows = this.db.all<{ mem_peak: number }>(
      `SELECT u.mem_peak FROM turns u JOIN threads x ON x.id=u.thread
       WHERE x.repo=? AND u.ended IS NOT NULL AND u.mem_peak>0 ORDER BY u.started DESC LIMIT 20`, t.repo);
    const v = rows.map((r) => r.mem_peak).sort((a, b) => a - b);
    return Math.max(v.length ? v[Math.ceil(0.9 * v.length) - 1] : 0, DEFAULT_MB[t.size === "heavy" ? "heavy" : "small"]);
  }

  // The thread row was read before the (slow) start of other threads, so every change here is conditional on it still being
  // in the state it was read in: a cancel or release in between wins, and a start that fails afterwards cannot undo it.
  private async launch(t: ThreadRow, host: string, prompt: string, est: number, back: "queued" | "idle"): Promise<"ok" | "retry" | "failed" | "skipped"> {
    const repo = this.repo(t.repo);
    if (!repo) { this.finish(t.id, "failed", `repo ${t.repo} is no longer configured`); return "failed"; }
    const epoch = t.epoch + 1, n = t.turns + 1, now = this.now();
    const h = this.db.host(host), memTotal = h ? (JSON.parse(h.hb) as Heartbeat).probe.memTotalMb : 0;
    const memMax = Math.round(memTotal ? Math.min(est * 2, memTotal * 0.9) : est * 2);
    const claimed = this.db.tx(() => {
      const r = this.db.run("UPDATE threads SET state='running',host=?,epoch=?,turns=?,reason=NULL,updated=? WHERE id=? AND state=? AND epoch=?", host, epoch, n, now, t.id, back, t.epoch);
      if (r.changes === 0) return false;
      this.db.run("INSERT INTO turns(thread,n,epoch,host,started,est_mb,mem_max,last_activity) VALUES(?,?,?,?,?,?,?,?)", t.id, n, epoch, host, now, est, memMax, now);
      return true;
    });
    if (!claimed) return "skipped";
    const body: StartTurn = {
      thread: t.id, epoch, turn: n, repoUrl: repo.url, repoId: t.repo, ref: t.ref, branch: t.branch,
      sessionId: t.session_id, resume: t.turns > 0, prompt, model: t.model ?? undefined,
      memoryMaxMb: memMax, runtimeMaxSec: this.cfg.runtimeMaxSec, rust: repo.rust,
    };
    const mine = () => { const c = this.db.thread(t.id); return !!c && c.state === "running" && c.epoch === epoch; };
    try {
      const res = await this.agent.start(host, body);
      if (res.ok) return "ok";
      if (!mine()) return "skipped";
      this.db.run("UPDATE turns SET ended=?, kind='launch-failed' WHERE thread=? AND n=?", this.now(), t.id, n);
      this.finish(t.id, "failed", res.error ?? "start rejected", { isError: true });
      return "failed";
    } catch {
      // The epoch stays bumped: if the agent did start it, its events are stale and the next heartbeat stops it.
      this.db.tx(() => {
        const r = this.db.run("UPDATE threads SET state=?,host=?,turns=?,updated=? WHERE id=? AND state='running' AND epoch=?",
          back, back === "queued" ? null : host, n - 1, this.now(), t.id, epoch);
        if (r.changes) this.db.run("DELETE FROM turns WHERE thread=? AND n=?", t.id, n);
      });
      return "retry";
    }
  }

  // ---- the tick ----
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const step of [this.hosts, this.stalls, this.sends, this.doctors, this.place, this.cleanup, () => this.reports.retry()])
        try { await step.call(this); } catch (e) { console.error("tick step failed:", e); }
    } finally { this.busy = false; }
  }

  idle() { return Promise.all([...this.docWork]); }

  private hosts() {
    const now = this.now(), quiet = this.cfg.lostAfterSec * 1000;
    for (const h of this.db.all<HostRow>("SELECT * FROM hosts WHERE state IN ('ok','refused','asleep')")) {
      const silent = now - h.seen;
      if (silent <= quiet) continue;
      const mac = (JSON.parse(h.hb) as Heartbeat).probe.os === "darwin";
      const next = mac && silent < this.cfg.asleepLostSec * 1000 ? "asleep" : "lost";
      if (next !== h.state)
        this.db.setHost(h.name, { state: next, since: now, reason: next === "asleep" ? "no heartbeat, host is asleep" : `no heartbeat for ${Math.round(silent / 1000)}s` });
    }
    for (const t of this.db.all<ThreadRow>("SELECT * FROM threads WHERE state='running' AND host IN (SELECT name FROM hosts WHERE state='lost')")) {
      this.db.run("UPDATE turns SET ended=?, kind='lost' WHERE thread=? AND ended IS NULL", now, t.id);
      this.db.setThread(t.id, { epoch: t.epoch + 1 });   // a reconnecting agent now holds a stale epoch and is told to stop
      this.finish(t.id, "lost", "host lost");
    }
    for (const t of this.db.all<ThreadRow>(
      "SELECT * FROM threads WHERE state='running' AND IFNULL(reason,'')<>'host-asleep' AND host IN (SELECT name FROM hosts WHERE state='asleep')")) {
      this.db.setThread(t.id, { reason: "host-asleep" });
      this.reports.add(t.id, "turn", { reason: "host-asleep" });
    }
  }

  private async stalls() {
    const cut = this.now() - this.cfg.stallMin * 60_000;
    for (const t of this.db.all<ThreadRow>(
      `SELECT t.* FROM threads t JOIN turns u ON u.thread=t.id AND u.n=t.turns
       WHERE t.state='running' AND u.ended IS NULL AND u.last_activity<? AND t.host IN (SELECT name FROM hosts WHERE state='ok')`, cut)) {
      await this.kill(t, "stalled");
      this.finish(t.id, "stalled", `stalled: no events and no CPU for ${this.cfg.stallMin} min`);
    }
  }

  private async sends() {
    for (const { thread } of this.db.all<{ thread: string }>(
      "SELECT s.thread FROM sends s JOIN threads t ON t.id=s.thread WHERE t.state='idle' GROUP BY s.thread ORDER BY MIN(s.id)")) {
      const t = this.get(thread), h = t.host ? this.db.host(t.host) : null;
      if (t.state !== "idle") continue;   // cancelled or released while an earlier follow-up was starting
      if (!h || h.state === "lost") { this.finish(t.id, "lost", "host lost before the follow-up could start"); continue; }
      if (h.state !== "ok" || this.db.runningOn(h.name) >= this.maxThreads(h) || this.now() < Number(this.db.meta("hold_until") ?? 0)) continue;
      const sends = this.db.all<{ id: number; text: string }>("SELECT id,text FROM sends WHERE thread=? ORDER BY id", thread);
      if (!sends.length) continue;
      const r = await this.launch(t, h.name, sends.map((s) => s.text).join("\n\n"), this.estimate(t), "idle");
      if (r === "ok") this.db.run(`DELETE FROM sends WHERE thread=? AND id<=?`, thread, sends[sends.length - 1].id);
    }
  }

  maxThreads(h: HostRow) { return (JSON.parse(h.hb) as Heartbeat).maxThreads ?? this.hostCfg(h.name)?.maxThreads ?? 4; }

  private doctors() {
    const now = this.now();
    for (const h of this.db.all<HostRow>("SELECT * FROM hosts WHERE state='ok'"))
      for (const [id, repo] of Object.entries(this.repos())) {
        const key = `${h.name}|${id}`, d = this.db.get<{ ok: number; at: number }>("SELECT ok,at FROM doctor WHERE host=? AND repo=?", h.name, id);
        // A failure is re-checked sooner than a pass so a fixed host is not shut out for a day.
        if (!repo.doctor || (d && now - d.at < (d.ok ? DAY : 600_000))) continue;
        if (this.docKeys.has(key)) continue;
        this.docKeys.add(key);
        const p: Promise<unknown> = this.agent.doctor(h.name, { repoId: id, repoUrl: repo.url, command: repo.doctor })
          .then((res) => this.db.run("INSERT OR REPLACE INTO doctor(host,repo,ok,output,at) VALUES(?,?,?,?,?)", h.name, id, res.ok ? 1 : 0, res.output, this.now()))
          .catch(() => {})
          .finally(() => { this.docKeys.delete(key); this.docWork.delete(p); });
        this.docWork.add(p);
      }
  }

  // The memory host h would have left after starting thread t, or why it cannot start it now.
  private fit(t: Pick<ThreadRow, "repo" | "requires">, est: number, h: HostRow): number | string {
    if (h.state !== "ok") return h.reason ? `${h.state}: ${h.reason}` : h.state;
    const repo = this.repo(t.repo), need: string[] = [...JSON.parse(t.requires), ...(repo?.requires ?? [])];   // no repo: launch fails the thread
    const hb = JSON.parse(h.hb) as Heartbeat, p = hb.probe, labels = hb.labels ?? this.hostCfg(h.name)?.labels ?? [], f = this.cfg.floors;
    const missing = need.filter((l) => !labels.includes(l));
    if (missing.length) return `lacks label ${missing.join(",")}`;
    const doc = repo?.doctor ? this.db.get<{ ok: number; output: string }>("SELECT ok,output FROM doctor WHERE host=? AND repo=?", h.name, t.repo) : null;
    if (repo?.doctor && !doc) return "doctor not run yet";
    if (doc && !doc.ok) return `doctor failed: ${doc.output.trim().split("\n").pop()!.slice(0, 160)}`;
    const run = this.db.runningOn(h.name), max = this.maxThreads(h);
    if (run >= max) return `full ${run}/${max}`;
    if (p.diskFreePct < f.diskFreePct) return `disk ${p.diskFreePct}% free, floor ${f.diskFreePct}%`;
    // Memory promised to running turns and not used yet (their estimate less their peak so far) is not free, whatever
    // the last probe says: a build that peaks twenty minutes in must not find its memory handed to another thread.
    const reserved = this.db.get<{ s: number | null }>(
      "SELECT SUM(MAX(est_mb-mem_peak,0)) s FROM turns WHERE host=? AND ended IS NULL", h.name)!.s ?? 0;
    const free = p.memAvailMb - reserved - est;
    return free < f.memReserveMb ? `memory ${p.memAvailMb - reserved} MB free, needs ${est}+${f.memReserveMb}` : free;
  }

  private pick(t: ThreadRow, est: number): string | null {
    let best: string | null = null, bestFree = -1;
    for (const h of this.db.all<HostRow>("SELECT * FROM hosts WHERE state='ok'")) {
      const free = this.fit(t, est, h);
      if (typeof free === "number" && free > bestFree) { best = h.name; bestFree = free; }
    }
    return best;
  }

  private async place() {
    if (this.now() < Number(this.db.meta("hold_until") ?? 0)) return;
    // A thread that fits nowhere is skipped, not blocking, so small work still flows past a heavy one.
    for (const t of this.db.all<ThreadRow>("SELECT * FROM threads WHERE state='queued' ORDER BY priority DESC, created, rowid")) {
      const est = this.estimate(t), host = this.pick(t, est);
      if (host) await this.launch(t, host, t.prompt, est, "queued");
    }
  }

  private async cleanup() {
    const now = this.now();
    for (const t of this.db.all<ThreadRow>(
      "SELECT * FROM threads WHERE state='idle' AND idle_at+ttl_hours*3600000<? AND NOT EXISTS(SELECT 1 FROM sends WHERE thread=threads.id)", now))
      this.finish(t.id, "done", "ttl");
    for (const t of this.db.all<ThreadRow>(
      `SELECT * FROM threads WHERE released=0 AND host IS NOT NULL
       AND (state='done' OR (state IN ('failed','lost','stalled','cancelled') AND final_at<?))`, now - DAY)) {
      if (this.db.host(t.host!)?.state === "ok") await this.free(t);
    }
  }

  // Read-only: the same checks place() and sends() make, phrased as why each waiting entry has not started.
  queue(hosts: HostView[]): QueueView {
    const now = this.now(), hold = Number(this.db.meta("hold_until") ?? 0), rows = this.db.all<HostRow>("SELECT * FROM hosts ORDER BY name");
    const held = now < hold ? `usage-limit hold until ${new Date(hold).toISOString()}` : null;
    const entry = (t: ThreadRow, since: number, waiting: string | null) => ({ id: t.id, caller: t.caller, repo: t.repo, tag: t.tag, host: t.host, since, waiting });
    const queued = this.db.all<ThreadRow>("SELECT * FROM threads WHERE state='queued' ORDER BY priority DESC, created, rowid").map((t) => {
      const est = this.estimate(t), fits = rows.map((h) => [h.name, this.fit(t, est, h)] as const);
      const waiting = held ?? (!rows.length ? "no host has reported"
        : fits.some(([, f]) => typeof f === "number") ? null : fits.map(([n, f]) => `${n}: ${f}`).join("; "));
      return { ...entry(t, t.created, waiting), priority: !!t.priority, estimateMb: est, prompt: t.prompt.slice(0, 500) };
    });
    const followUps = this.db.all<ThreadRow & { count: number; first: number }>(
      "SELECT t.*, COUNT(*) count, MIN(s.created) first FROM sends s JOIN threads t ON t.id=s.thread GROUP BY s.thread ORDER BY MIN(s.id)").map((t) => {
      const h = t.host ? this.db.host(t.host) : null, run = h ? this.db.runningOn(h.name) : 0;
      const waiting = t.state === "running" ? "current turn still running" : held
        ?? (!h || h.state !== "ok" ? `host ${t.host} ${h?.state ?? "unknown"}` : run >= this.maxThreads(h) ? `host full ${run}/${this.maxThreads(h)}` : null);
      const texts = this.db.all<{ text: string }>("SELECT text FROM sends WHERE thread=? ORDER BY id", t.id).map((x) => x.text.slice(0, 500));
      return { ...entry(t, t.first, waiting), count: t.count, texts };
    });
    const idle = this.db.all<ThreadRow>("SELECT * FROM threads WHERE state='idle' AND NOT EXISTS(SELECT 1 FROM sends WHERE thread=threads.id) ORDER BY idle_at DESC")
      .map((t) => ({ id: t.id, caller: t.caller, repo: t.repo, tag: t.tag, host: t.host, since: t.idle_at ?? t.updated, turns: t.turns, lastMessage: t.last_message?.slice(0, 600) ?? null }));
    const repoIds = Object.keys(this.repos()).sort();
    const running = this.db.all<ThreadRow & { started: number }>(
      "SELECT t.*, u.started FROM threads t JOIN turns u ON u.thread=t.id AND u.n=t.turns WHERE t.state='running' ORDER BY u.started");
    return {
      holdUntil: held ? hold : null, queued, followUps, idle,
      hosts: hosts.map((h) => ({ ...h, threads: running.filter((t) => t.host === h.name)
        .map((t) => ({ id: t.id, caller: t.caller, repo: t.repo, tag: t.tag, turn: t.turns, startedAt: t.started,
          activity: steps(this.db, t.id, t.turns, { n: 1, results: false }).steps[0] ?? null })),
        repos: Object.fromEntries(repoIds.map((r) => [r, this.eligibility(r, h.name)])) })),
    };
  }

  // Why a new thread of this repo could not start on that host now; null when it could.
  eligibility(repo: string, host: string): string | null {
    const h = this.db.host(host), t = { repo, requires: "[]", size: null };
    if (!h) return "never seen";
    const f = this.fit(t, this.estimate(t), h);
    return typeof f === "number" ? null : f;
  }

  views(caller: string | null) {
    const rows = caller
      ? this.db.all<ThreadRow>("SELECT * FROM threads WHERE caller=? ORDER BY created DESC LIMIT 500", caller)
      : this.db.all<ThreadRow>("SELECT * FROM threads ORDER BY created DESC LIMIT 500");
    return rows.map(threadView);
  }
}
