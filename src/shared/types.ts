// The one contract every part of wd shares: caller API, coordinator <-> agent protocol, report shape.
// Change this file first, then the parts. Keep it small.

export type ThreadState = "queued" | "running" | "idle" | "done" | "failed" | "lost" | "stalled" | "cancelled";
export const FINAL: ThreadState[] = ["done", "failed", "lost", "stalled", "cancelled"];

export type HostState = "ok" | "refused" | "asleep" | "lost" | "closed";

// ---- Caller API (HTTP on the coordinator, used by the CLI, the MCP plugin and services) ----

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface SubmitRequest {
  caller: string;            // who gets the reports, e.g. "orch:shop"
  repo: string;              // a registered repo id, e.g. "acme/shop"
  ref?: string;              // base ref, default the repo's default branch
  prompt: string;
  model?: string;            // passed to the runner's --model
  effort?: Effort;           // claude --effort, pi --thinking; default the host's settings
  runner?: "claude" | "pi";  // which agent runs the thread; default claude. pi models are "provider/id[:thinking]"
  billing?: "api" | "session";  // who pays for the turn; default session (the runner's stored subscription login). api: the envFile's keys
  requires?: string[];       // host labels that must all be present; every host also has its own name as a label
  size?: "small" | "heavy";  // only a hint until p90 estimates exist
  priority?: boolean;
  ttlHours?: number;         // worktree kept this long after the last turn, default 24
  tag?: string;              // caller's own label, echoed in every report
  branch?: string;           // default "wd/<thread id>"
}
export interface SubmitResponse { id: string; position: number }

export interface ThreadView {
  id: string; caller: string; repo: string; ref: string; branch: string; tag: string | null;
  state: ThreadState; host: string | null; epoch: number; turns: number;
  head: string | null; costUsd: number; lastMessage: string | null; reason: string | null;
  createdAt: number; updatedAt: number;
  messages?: { turn: number; text: string }[];   // ?full=1: every turn's whole result text, oldest first
}

export type ReportKind = "turn" | "final";
export interface Report {
  id: number; caller: string; thread: string; tag: string | null; kind: ReportKind;
  state: ThreadState; host: string | null; isError: boolean;
  message: string | null;      // claude's final result text for the turn, cut at 4000 chars
  truncated: boolean;          // message was cut: GET /threads/:id?full=1 (wd status <id> --full) has every turn's whole text
  branch: string; head: string | null; pushed: boolean;
  turnCostUsd: number; turnSeconds: number;
  reason: string | null;       // for failures: launch stderr tail, "oom", "host lost", "stalled", "cap: ..."
  createdAt: number;
}

export interface HostView {
  name: string; os: "linux" | "darwin"; state: HostState; reason: string | null; labels: string[];
  cores: number; memTotalMb: number; memAvailMb: number; diskFreePct: number;
  load1: number;               // 1-minute load average: every process on the host, wd's or not
  cpuScore: number | null;     // single-core benchmark, the best seen (agent/probe.ts): relative host speed
  running: number; maxThreads: number | null;   // null: no cap, memory and CPU decide
  claudeVersion: string | null; loginExpiresAt: number | null; lastSeenAt: number | null;
  piVersion: string | null; piOk: boolean; piError: string | null;   // the pi runner's readiness (nulls before 0.4.8)
  doctorFailed: string[];      // repos whose doctor fails here: none of their threads go to this host
  why?: string | null;         // GET /hosts?repo=: why a thread of that repo cannot start here now; null when it can
}

// GET /queue: what waits for a host and what runs where, across every caller.
// `waiting` says why an entry has not started; null means it starts on the next scheduler tick.
export interface QueueEntry { id: string; caller: string; repo: string; tag: string | null; host: string | null; since: number; waiting: string | null }
export interface QueueView {
  holdUntil: number | null;                                    // usage-limit hold on all new starts
  queued: (QueueEntry & { priority: boolean; estimateMb: number; holds: string | null; prompt: string })[];   // holds: the host kept for it   // in placement order; prompt cut at 500 chars
  followUps: (QueueEntry & { count: number; texts: string[] })[];   // sends waiting to start a turn on their thread's host, each cut at 500
  // Finished a turn, worktree kept for a follow-up or a release; not using a slot. lastMessage cut at 600 chars.
  idle: { id: string; caller: string; repo: string; tag: string | null; host: string | null; since: number; turns: number; lastMessage: string | null }[];
  hosts: (HostView & {
    threads: { id: string; caller: string; repo: string; tag: string | null; turn: number; startedAt: number; activity: Step | null }[];
    repos: Record<string, string | null>;                      // every repo: why a new thread of it could not start here now, null when it could
  })[];
}

// One step of a turn, summarised from its stream-json events: a tool call ("Bash: bun test"), text claude wrote,
// a tool result ("↳ ..."), or the end. `at` is when the coordinator received it; 0 for events stored before wd recorded that.
export interface Step { at: number; text: string }
// GET /threads/:id/steps?n=&after=: the latest steps of the thread's current (or ?turn=) turn. Pass `next` back as `after`
// to get only newer steps.
export interface Steps { thread: string; turn: number; running: boolean; steps: Step[]; next: number }

// ---- Coordinator -> agent (HTTP on the agent, bearer = host token) ----

export interface StartTurn {
  thread: string; epoch: number; turn: number;
  repoUrl: string; repoId: string; ref: string; branch: string;
  sessionId: string; resume: boolean;   // claude turn 1: --session-id, later turns: --resume; pi: --session-id every turn
  prompt: string; model?: string; effort?: Effort;
  runner?: "claude" | "pi";            // absent = claude; pi runs the agent's `pi` binary instead of `claude`
  billing?: "api" | "session";         // session drops *_API_KEY and uses the stored login; api: the envFile's keys bill the turn (absent: session; agents before 0.4.11 read absent as api)
  memoryMaxMb: number; runtimeMaxSec: number;
}
export interface StopTurn { thread: string; epoch: number }
export interface Release { thread: string }       // remove worktree + tmp, release lane
export interface DoctorRequest { repoId: string; repoUrl: string; command: string }
export interface DoctorResult { ok: boolean; output: string }   // output tail, 4000 chars

// ---- Agent -> coordinator (HTTP on the coordinator, bearer = host token) ----

export interface Probe {
  os: "linux" | "darwin"; cores: number; memTotalMb: number; memAvailMb: number;
  diskFreePct: number; diskFreeGb: number;
  load1?: number; cpuScore?: number;   // absent from agents before 0.4.0
  claudeVersion: string | null; loginOk: boolean; loginError: string | null; loginExpiresAt: number | null;
  piVersion: string | null; piOk: boolean; piError: string | null;   // absent from agents before 0.4.8: all null
  problems: string[];          // anything that should refuse the host, human readable
}
export interface UnitStatus { thread: string; epoch: number; turn: number; running: boolean; cpuMs: number; memPeakMb: number }

// labels and maxThreads come from the agent's own config (agent.json); the coordinator falls back to coord.json if absent.
export interface Heartbeat { host: string; agentVersion: string; probe: Probe; units: UnitStatus[]; labels?: string[]; maxThreads?: number }
// Coordinator answers a heartbeat with units to stop (stale epochs, cancelled threads).
export interface HeartbeatReply { stop: StopTurn[]; version?: string }   // version: the coordinator's; an older agent updates itself to it

export interface EventsBatch {
  host: string; thread: string; epoch: number; turn: number;
  offset: number;               // byte offset of the first line in this batch
  lines: string[];              // raw stream-json lines, each truncated to 8000 chars by the agent
  nextOffset: number;
}
export interface EventsAck { committed: number }  // agent resends from here; stale epoch => 409

export interface TurnEnd {
  host: string; thread: string; epoch: number; turn: number;
  exitCode: number | null;
  kind: "exited" | "oom" | "timeout" | "killed" | "launch-failed" | "lost";
  stderrTail: string;
  result: { isError: boolean; text: string | null; totalCostUsd: number; durationMs: number } | null;
  head: string | null; pushed: boolean; pushError: string | null;
  memPeakMb: number;
}

// GET /agent/threads?host=<name>: ids of the threads the coordinator still holds on that host (not final, or final but not
// yet released). The agent's orphan sweep removes the leftovers of every other thread.
export interface AgentThreads { threads: string[] }

export const AGENT_PORT = 7781;
export const COORD_PORT = 7780;
