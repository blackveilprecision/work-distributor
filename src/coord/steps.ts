// What a running turn is doing, read from the stream-json events the agent sends: one short line per step.
import type { Step, Steps } from "../shared/types";
import type { Db } from "./db";

const one = (s: string, n = 140) => { const l = s.replace(/\s+/g, " ").trim(); return l.length > n ? l.slice(0, n - 1) + "…" : l; };
const INPUT_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"];

function toolText(name: string, input: any): string {
  const k = INPUT_KEYS.find((k) => typeof input?.[k] === "string");
  return one(`${name}: ${k ? input[k] : JSON.stringify(input ?? {})}`);
}

// Lines over 8000 chars arrive cut, so they are not JSON; a tool call's name, and its first input (a Write's file_path), is
// still at the front.
export function summarize(raw: string): string[] {
  let e: any;
  try { e = JSON.parse(raw); } catch {
    const m = /"type":"tool_use","id":"[^"]*","name":"([^"]+)","input":\{(?:"(\w+)":"((?:[^"\\]|\\.){0,300})")?/.exec(raw);
    if (!m) return [];
    return [m[2] && INPUT_KEYS.includes(m[2]) ? one(`${m[1]}: ${JSON.parse(`"${m[3]}"`)}`) : `${m[1]}: …`];
  }
  const content = Array.isArray(e?.message?.content) ? e.message.content : [];
  if (e.type === "assistant") return content.flatMap((c: any) =>
    c.type === "tool_use" ? [toolText(c.name, c.input)] : c.type === "text" && c.text?.trim() ? [one(c.text)] : []);
  if (e.type === "user") return content.flatMap((c: any) => {
    if (c.type !== "tool_result") return [];
    const t = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? "").join(" ") : "";
    return [one(`↳ ${c.is_error ? "error: " : ""}${t || "(no output)"}`, 120)];
  });
  if (e.type === "result") return [one(`done${e.is_error ? " (error)" : ""}: ${e.result ?? ""}`)];
  if (e.type === "system" && e.subtype === "init") return ["session started"];
  return [];
}

interface Row { offset: number; next_offset: number; line: string; at: number | null }

// The newest steps first are found by reading event rows backwards until enough are found.
export function steps(db: Db, thread: string, turn: number, o: { n?: number; after?: number; results?: boolean } = {}): { steps: Step[]; next: number } {
  const n = o.n ?? 20, after = o.after ?? 0, out: Step[] = [];
  let next = after, before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = db.all<Row>(`SELECT "offset", next_offset, line, at FROM events WHERE thread=? AND turn=? AND "offset">=? AND "offset"<? ORDER BY "offset" DESC LIMIT 50`,
      thread, turn, after, before);
    if (!rows.length) break;
    next = Math.max(next, rows[0].next_offset);
    for (const r of rows) {
      const got = (JSON.parse(r.line) as string[]).flatMap(summarize).filter((t) => o.results !== false || !t.startsWith("↳"));
      out.unshift(...got.map((text) => ({ at: r.at ?? 0, text })));
    }
    if (out.length >= n) break;
    before = rows[rows.length - 1].offset;
  }
  return { steps: out.slice(-n), next };
}

export function latestTurn(db: Db, thread: string): { n: number; ended: number | null } | null {
  return db.get<{ n: number; ended: number | null }>("SELECT n, ended FROM turns WHERE thread=? ORDER BY n DESC LIMIT 1", thread);
}

export function threadSteps(db: Db, thread: string, q: { turn?: number; n?: number; after?: number }): Steps | null {
  const last = latestTurn(db, thread);
  if (!last) return null;
  const turn = q.turn ?? last.n, ended = db.get<{ ended: number | null }>("SELECT ended FROM turns WHERE thread=? AND n=?", thread, turn);
  if (!ended) return null;
  return { thread, turn, running: ended.ended === null, ...steps(db, thread, turn, { n: q.n, after: q.after }) };
}
