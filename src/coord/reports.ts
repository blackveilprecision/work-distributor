import type { Report, ReportKind } from "../shared/types";
import type { Db } from "./db";

export type Poster = (url: string, body: unknown) => Promise<boolean>;

export const httpPost: Poster = async (url, body) => {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch { return false; }
};

interface Row { id: number; caller: string; body: string; created: number; attempts: number }
const toReport = (r: Row): Report => ({ ...JSON.parse(r.body), id: r.id, createdAt: r.created });

// A report is a row until the caller acks it (or a webhook answers 2xx); nothing expires.
export class Reports {
  private subs = new Map<string, Set<(r: Report) => void>>();
  private inflight = new Set<number>();
  constructor(private db: Db, private now: () => number = Date.now, private post: Poster = httpPost) {}

  add(threadId: string, kind: ReportKind, o: Partial<Report> = {}): Report {
    const t = this.db.thread(threadId)!;
    const body = {
      caller: t.caller, thread: t.id, tag: t.tag, kind, state: t.state, host: t.host, isError: false, message: null,
      branch: t.branch, head: t.head, pushed: false, turnCostUsd: 0, turnSeconds: 0, reason: t.reason, ...o, truncated: false,
    };
    if (body.message && body.message.length > 4000) Object.assign(body, { message: body.message.slice(0, 4000), truncated: true });
    const created = this.now();
    const { lastInsertRowid } = this.db.run("INSERT INTO reports(caller,thread,body,created) VALUES(?,?,?,?)", t.caller, t.id, JSON.stringify(body), created);
    const r = { ...body, id: Number(lastInsertRowid), createdAt: created } as Report;
    for (const fn of this.subs.get(t.caller) ?? []) fn(r);
    void this.deliver(r.id);
    return r;
  }

  pending(caller: string | null, after = 0): Report[] {
    const rows = caller
      ? this.db.all<Row>("SELECT * FROM reports WHERE acked IS NULL AND caller=? AND id>? ORDER BY id", caller, after)
      : this.db.all<Row>("SELECT * FROM reports WHERE acked IS NULL AND id>? ORDER BY id", after);
    return rows.map(toReport);
  }

  ack(id: number) { return this.db.run("UPDATE reports SET acked=? WHERE id=? AND acked IS NULL", this.now(), id).changes > 0; }

  subscribe(caller: string, fn: (r: Report) => void) {
    const set = this.subs.get(caller) ?? new Set();
    set.add(fn); this.subs.set(caller, set);
    return () => { set.delete(fn); };
  }

  async deliver(id: number) {
    if (this.inflight.has(id)) return;
    const r = this.db.get<Row>("SELECT * FROM reports WHERE id=? AND acked IS NULL", id);
    const hook = r && this.db.get<{ webhook: string | null }>("SELECT webhook FROM callers WHERE name=?", r.caller)?.webhook;
    if (!r || !hook) return;
    this.inflight.add(id);
    try {
      if (await this.post(hook, toReport(r))) this.ack(id);
      else this.db.run("UPDATE reports SET attempts=attempts+1, next_try=? WHERE id=?", this.now() + Math.min(5000 * 2 ** r.attempts, 600_000), id);
    } finally { this.inflight.delete(id); }
  }

  async retry() {
    const due = this.db.all<{ id: number }>(
      "SELECT r.id FROM reports r JOIN callers c ON c.name=r.caller WHERE r.acked IS NULL AND c.webhook IS NOT NULL AND r.next_try<=? ORDER BY r.id LIMIT 50", this.now());
    await Promise.all(due.map((d) => this.deliver(d.id)));
  }
}
