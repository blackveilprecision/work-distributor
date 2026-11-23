import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RepoCfg } from "./config";
import type { ThreadState, ThreadView } from "../shared/types";

export interface ThreadRow {
  id: string; caller: string; repo: string; ref: string; branch: string; tag: string | null;
  prompt: string; model: string | null; requires: string; size: string | null; priority: number; ttl_hours: number;
  state: ThreadState; host: string | null; epoch: number; turns: number; head: string | null; cost: number;
  last_message: string | null; reason: string | null; session_id: string; released: number;
  created: number; updated: number; idle_at: number | null; final_at: number | null;
}
export interface TurnRow {
  thread: string; n: number; epoch: number; host: string; started: number; ended: number | null; kind: string | null;
  cost: number; mem_peak: number; result: string | null; est_mb: number; mem_max: number;
  last_activity: number; cpu_ms: number; committed: number;
}
export interface HostRow { name: string; hb: string; seen: number; state: string; reason: string | null; since: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, caller TEXT NOT NULL, repo TEXT, ref TEXT, branch TEXT, tag TEXT,
  prompt TEXT, model TEXT, requires TEXT, size TEXT, priority INTEGER DEFAULT 0, ttl_hours REAL DEFAULT 24, state TEXT,
  host TEXT, epoch INTEGER DEFAULT 0, turns INTEGER DEFAULT 0, head TEXT, cost REAL DEFAULT 0, last_message TEXT, reason TEXT,
  session_id TEXT, released INTEGER DEFAULT 0, created INTEGER, updated INTEGER, idle_at INTEGER, final_at INTEGER);
CREATE INDEX IF NOT EXISTS threads_state ON threads(state);
CREATE TABLE IF NOT EXISTS turns(thread TEXT, n INTEGER, epoch INTEGER, host TEXT, started INTEGER, ended INTEGER, kind TEXT,
  cost REAL DEFAULT 0, mem_peak INTEGER DEFAULT 0, result TEXT, est_mb INTEGER, mem_max INTEGER, last_activity INTEGER,
  cpu_ms INTEGER DEFAULT 0, committed INTEGER DEFAULT 0, PRIMARY KEY(thread, n));
CREATE TABLE IF NOT EXISTS events(thread TEXT, turn INTEGER, "offset" INTEGER, next_offset INTEGER, line TEXT,
  PRIMARY KEY(thread, turn, "offset"));
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT, caller TEXT, thread TEXT, body TEXT, created INTEGER,
  acked INTEGER, attempts INTEGER DEFAULT 0, next_try INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS reports_caller ON reports(caller, acked);
CREATE TABLE IF NOT EXISTS sends(id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT, text TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS hosts(name TEXT PRIMARY KEY, hb TEXT, seen INTEGER, state TEXT, reason TEXT, since INTEGER);
CREATE TABLE IF NOT EXISTS doctor(host TEXT, repo TEXT, ok INTEGER, output TEXT, at INTEGER, PRIMARY KEY(host, repo));
CREATE TABLE IF NOT EXISTS callers(name TEXT PRIMARY KEY, webhook TEXT);
CREATE TABLE IF NOT EXISTS reg_hosts(name TEXT PRIMARY KEY, url TEXT, token TEXT);
CREATE TABLE IF NOT EXISTS reg_repos(id TEXT PRIMARY KEY, spec TEXT);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`;

// The coordinator process is the only writer; every other part goes through the API.
export class Db {
  raw: Database;
  constructor(path: string, public now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.raw.exec(SCHEMA);
    // Added after the first release: when each event batch arrived. Fails harmlessly once the column exists.
    try { this.raw.exec("ALTER TABLE events ADD COLUMN at INTEGER"); } catch {}
  }
  all<T>(sql: string, ...p: any[]): T[] { return this.raw.query(sql).all(...p) as T[]; }
  get<T>(sql: string, ...p: any[]): T | null { return (this.raw.query(sql).get(...p) as T) ?? null; }
  run(sql: string, ...p: any[]) { return this.raw.query(sql).run(...p); }
  tx<T>(f: () => T): T { return this.raw.transaction(f)(); }

  private set(table: string, key: string, id: any, f: Record<string, any>) {
    const ks = Object.keys(f);
    if (ks.length) this.run(`UPDATE ${table} SET ${ks.map((k) => `${k}=?`).join(",")} WHERE ${key}=?`, ...ks.map((k) => f[k]), id);
  }
  thread(id: string) { return this.get<ThreadRow>("SELECT * FROM threads WHERE id=?", id); }
  setThread(id: string, f: Record<string, any>) { this.set("threads", "id", id, { ...f, updated: this.now() }); }
  host(name: string) { return this.get<HostRow>("SELECT * FROM hosts WHERE name=?", name); }
  setHost(name: string, f: Record<string, any>) { this.set("hosts", "name", name, f); }
  turn(thread: string, n: number) { return this.get<TurnRow>("SELECT * FROM turns WHERE thread=? AND n=?", thread, n); }
  meta(k: string) { return this.get<{ v: string }>("SELECT v FROM meta WHERE k=?", k)?.v ?? null; }
  setMeta(k: string, v: string) { this.run("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", k, v); }
  // Hosts and repos registered through the API; the scheduler merges them with the ones in coord.json (see Scheduler.hostCfg / repo).
  regHosts() { return Object.fromEntries(this.all<{ name: string; url: string; token: string }>("SELECT * FROM reg_hosts").map((h) => [h.name, { url: h.url, token: h.token }])); }
  regRepos() { return Object.fromEntries(this.all<{ id: string; spec: string }>("SELECT * FROM reg_repos").map((r) => [r.id, JSON.parse(r.spec) as RepoCfg])); }
  runningOn(host: string) { return this.get<{ c: number }>("SELECT COUNT(*) c FROM threads WHERE state='running' AND host=?", host)!.c; }
}

export function threadView(t: ThreadRow): ThreadView {
  return {
    id: t.id, caller: t.caller, repo: t.repo, ref: t.ref, branch: t.branch, tag: t.tag, state: t.state, host: t.host,
    epoch: t.epoch, turns: t.turns, head: t.head, costUsd: t.cost, lastMessage: t.last_message, reason: t.reason,
    createdAt: t.created, updatedAt: t.updated,
  };
}
