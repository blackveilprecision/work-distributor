// Follows one turn's out.jsonl from a persisted byte offset and reports it to the coordinator. The offset moves only
// to what the coordinator committed, so events are applied exactly once across agent restarts and coordinator outages.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventsAck, EventsBatch, StartTurn, TurnEnd } from "../shared/types";
import { type AgentConfig, lastChars, post, sleep } from "./config";
import { endOf, status, stopTurn, sweep, type TurnMeta } from "./launch";
import { pushWork, releaseTarget, type Pushed } from "./workspace";

export interface Active {
  meta: TurnMeta; cpuMs: number; memPeakMb: number; running: boolean; stale: boolean; done: Promise<void>;
}
export interface Ctx { cfg: AgentConfig; version: string; active: Map<string, Active>; preparing: Map<string, StartTurn>; closed: boolean }

const CHUNK = 1 << 20, BUDGET = 8 << 20, KEEP = 8000, MAX_BATCH_LINES = 500, MAX_BATCH_BYTES = 1 << 20;
export interface Line { at: number; text: string; result?: string }

// Complete lines after `offset`, of any length: a partial line is held until its newline arrives (or, with `final`,
// until the file ends), and only then truncated to KEEP chars. `next` always sits at a line start, so a restart
// re-reads a half-written line whole. A result line is kept in full, since the turn's outcome is parsed from it.
export function readLines(file: string, offset: number, final: boolean): { lines: Line[]; next: number } {
  const lines: Line[] = [];
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return { lines, next: offset }; }
  const make = (at: number, buf: Buffer): Line => {
    // Real claude does not put "type" first, so the line is parsed; result lines are small, giant lines are tool output.
    let isResult = false;
    if (buf.length < 1_000_000 && buf.includes('"type":"result"')) try { isResult = JSON.parse(buf.toString()).type === "result"; } catch {}
    // 4 bytes per char is the most a UTF-8 char takes, so decoding KEEP*4 bytes always covers KEEP chars.
    return { at, text: buf.subarray(0, KEEP * 4).toString().slice(0, KEEP), ...(isResult ? { result: buf.toString() } : {}) };
  };
  try {
    const size = fstatSync(fd).size;
    let pos = offset, start = offset, read = 0, held: Buffer[] = [];
    while (pos < size && (read < BUDGET || held.length)) {
      const chunk = Buffer.alloc(Math.min(CHUNK, size - pos));
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n === 0) break;
      let from = 0;
      for (let nl = chunk.indexOf(10); nl !== -1 && nl < n; nl = chunk.indexOf(10, from)) {
        lines.push(make(start, Buffer.concat([...held, chunk.subarray(from, nl)])));
        held = [];
        from = nl + 1;
        start = pos + from;
      }
      if (from < n) held.push(chunk.subarray(from, n));
      pos += n;
      read += n;
    }
    if (final && pos >= size && held.length) { lines.push(make(start, Buffer.concat(held))); start = pos; }
    return { lines, next: start };
  } finally {
    closeSync(fd);
  }
}

const num = (file: string) => (existsSync(file) ? Number(readFileSync(file, "utf8")) || 0 : 0);

// "ok": everything read was committed or the coordinator asked for a resend; "retry": coordinator down or refusing;
// "stale": a 409, the epoch is dead.
async function sendLines(ctx: Ctx, a: Active, lines: Line[], next: number, offset: { v: number }): Promise<"ok" | "retry" | "stale"> {
  const { s, dir } = a.meta;
  for (let i = 0; i < lines.length; ) {
    let j = i, bytes = 0;
    while (j < lines.length && j - i < MAX_BATCH_LINES && (bytes += lines[j].text.length) < MAX_BATCH_BYTES) j++;
    j = Math.max(j, i + 1);
    const end = j < lines.length ? lines[j].at : next;
    const body: EventsBatch = { host: ctx.cfg.name, thread: s.thread, epoch: s.epoch, turn: s.turn, offset: lines[i].at, lines: lines.slice(i, j).map((l) => l.text), nextOffset: end };
    const r = await post(ctx.cfg, "/agent/events", body);
    if (r.status === 409) return "stale";
    const committed = (r.body as EventsAck | null)?.committed;
    if (r.status !== 200 || typeof committed !== "number") return "retry";
    offset.v = committed;
    writeFileSync(join(dir, "offset"), String(committed));
    if (committed < end) return "ok";
    i = j;
  }
  return "ok";
}

function parseResult(raw: string): TurnEnd["result"] {
  try {
    const j = JSON.parse(raw);
    return { isError: j.is_error === true, text: typeof j.result === "string" ? j.result : null, totalCostUsd: Number(j.total_cost_usd) || 0, durationMs: Number(j.duration_ms) || 0 };
  } catch { return null; }
}

export async function tailTurn(ctx: Ctx, a: Active): Promise<void> {
  const { cfg } = ctx, { meta } = a, { dir, s } = meta;
  const out = join(dir, "out.jsonl"), offset = { v: num(join(dir, "offset")) };
  const sentFile = join(dir, "turnend.json");
  let backoff = cfg.tailMs, lastPush = Date.now(), pushing: Promise<unknown> | null = null;

  if (!existsSync(sentFile)) for (;;) {
    if (ctx.closed) return;
    if (a.stale) break;   // stopped for a dead epoch: nothing more is sent
    const st = await status(meta);
    a.running = st.running; a.cpuMs = st.cpuMs; a.memPeakMb = Math.max(a.memPeakMb, st.memMb);
    if (st.running && Date.now() - meta.startedAt > s.runtimeMaxSec * 1000) await stopTurn(meta, "timeout");
    if (st.running && !pushing && Date.now() - lastPush > cfg.pushEverySec * 1000) {
      lastPush = Date.now();
      pushing = pushWork(cfg, s.thread, s.branch, false).finally(() => { pushing = null; });
    }
    // Read after the liveness check: once the process is gone nothing more can be appended.
    const { lines, next } = readLines(out, offset.v, !st.running);
    for (const l of lines) if (l.result) writeFileSync(join(dir, "result.json"), l.result);
    const before = offset.v;
    const r = lines.length ? await sendLines(ctx, a, lines, next, offset) : "ok";
    if (r === "stale") { a.stale = true; await stopTurn(meta, "stale"); break; }
    if (r === "retry") { await sleep(backoff); backoff = Math.min(backoff * 2, 30_000); continue; }
    backoff = cfg.tailMs;
    const size = existsSync(out) ? statSync(out).size : 0;
    if (!st.running && offset.v >= size) break;
    if (!lines.length || offset.v >= size || offset.v === before) await sleep(cfg.tailMs);
  }
  await pushing;

  if (!a.stale) {
    if (!existsSync(sentFile)) {
      await sweep(meta);
      const end = await endOf(meta);
      const raw = existsSync(join(dir, "result.json")) ? readFileSync(join(dir, "result.json"), "utf8") : null;
      const result = raw ? parseResult(raw) : null;
      const err = existsSync(join(dir, "err.log")) ? readFileSync(join(dir, "err.log"), "utf8") : "";
      const noOutput = !existsSync(out) || statSync(out).size === 0;
      // 126/127 is bash failing to start claude; any other failure with no output at all never got going either.
      const kind = end.kind === "exited" && !result && (end.exitCode === 126 || end.exitCode === 127 || (end.exitCode !== 0 && noOutput)) ? "launch-failed" : end.kind;
      const w: Pushed = await pushWork(cfg, s.thread, s.branch, true);
      const te: TurnEnd = { host: cfg.name, thread: s.thread, epoch: s.epoch, turn: s.turn, exitCode: end.exitCode, kind, stderrTail: lastChars(err), result, head: w.head, pushed: w.pushed, pushError: w.pushError, memPeakMb: Math.round(a.memPeakMb) };
      writeFileSync(sentFile, JSON.stringify(te));   // a restart resends this instead of pushing again
    }
    const te = JSON.parse(readFileSync(sentFile, "utf8"));
    // Delivered until acknowledged. Any 4xx (a 409 stale epoch included) means the coordinator will never take it.
    for (let wait = cfg.tailMs; ; wait = Math.min(wait * 2, 30_000)) {
      if (ctx.closed) return;
      const r = await post(cfg, "/agent/turn-end", te);
      if (r.status >= 200 && r.status < 500) break;
      await sleep(wait);
    }
  }
  writeFileSync(join(dir, "ended"), String(Date.now()));
  releaseTarget(meta.target);
  ctx.active.delete(meta.key);
}
