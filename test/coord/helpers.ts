import type { DoctorRequest, DoctorResult, Heartbeat, Release, StartTurn, StopTurn, TurnEnd } from "../../src/shared/types";
import { parseConfig, type Config } from "../../src/coord/config";
import { Db } from "../../src/coord/db";
import { Reports } from "../../src/coord/reports";
import { Scheduler, type AgentClient } from "../../src/coord/scheduler";

export class FakeAgent implements AgentClient {
  started: { host: string; b: StartTurn }[] = [];
  stopped: { host: string; b: StopTurn }[] = [];
  released: { host: string; b: Release }[] = [];
  doctored: { host: string; b: DoctorRequest }[] = [];
  down = new Set<string>();
  rejectStart: string | null = null;
  doctorGate: Promise<void> | null = null;   // hold doctors in flight, as a real one would be
  doctorOk = new Map<string, boolean>();   // "host|repo" -> result, default true
  async start(host: string, b: StartTurn) {
    if (this.down.has(host)) throw new Error("unreachable");
    if (this.rejectStart) return { ok: false, error: this.rejectStart };
    this.started.push({ host, b });
    return { ok: true };
  }
  async stop(host: string, b: StopTurn) { this.stopped.push({ host, b }); }
  async release(host: string, b: Release) { if (this.down.has(host)) throw new Error("unreachable"); this.released.push({ host, b }); }
  async doctor(host: string, b: DoctorRequest): Promise<DoctorResult> {
    this.doctored.push({ host, b });
    await this.doctorGate;
    const ok = this.doctorOk.get(`${host}|${b.repoId}`) ?? true;
    return { ok, output: ok ? "ok" : "missing tool" };
  }
}

export function harness(over: Record<string, unknown> = {}) {
  const clock = { t: 1_000_000_000_000 };
  const cfg: Config = parseConfig({
    callerToken: "ct", db: ":memory:",
    hosts: { a: { url: "http://a", token: "ta" }, b: { url: "http://b", token: "tb" }, c: { url: "http://c", token: "tc" } },
    repos: {
      "o/app": { url: "git@x:o/app.git", defaultRef: "main", doctor: "true", requires: [], rust: false },
      "o/rs": { url: "git@x:o/rs.git", defaultRef: "dev", requires: [], rust: true },
    },
    ...over,
  });
  const now = () => clock.t;
  const db = new Db(":memory:", now);
  const posted: { url: string; body: any }[] = [];
  const hook = { ok: true };
  const reports = new Reports(db, now, async (url, body) => { posted.push({ url, body }); return hook.ok; });
  const agent = new FakeAgent();
  const sched = new Scheduler(db, cfg, agent, reports, now);
  return { clock, cfg, db, reports, agent, sched, posted, hook, advance: (ms: number) => { clock.t += ms; } };
}

export type H = ReturnType<typeof harness>;

export function hb(host: string, o: { os?: "linux" | "darwin"; memAvailMb?: number; diskFreePct?: number; labels?: string[]; maxThreads?: number;
  problems?: string[]; loginOk?: boolean; units?: Heartbeat["units"]; cores?: number; load1?: number; cpuScore?: number } = {}): Heartbeat {
  return {
    host, agentVersion: "t", labels: o.labels, maxThreads: o.maxThreads, units: o.units ?? [],
    probe: { os: o.os ?? "linux", cores: o.cores ?? 8, load1: o.load1 ?? 0, cpuScore: o.cpuScore, memTotalMb: 32768, memAvailMb: o.memAvailMb ?? 16000, diskFreePct: o.diskFreePct ?? 50, diskFreeGb: 100,
      claudeVersion: "2.0", loginOk: o.loginOk ?? true, loginError: null, loginExpiresAt: null, problems: o.problems ?? [] },
  };
}

// Heartbeat every host in `names`, then run a tick twice: the first tick starts the doctors, the second places.
export async function ready(h: H, names: string[], o: Parameters<typeof hb>[1] = {}) {
  for (const n of names) h.sched.onHeartbeat(hb(n, o));
  await h.sched.tick(); await h.sched.idle();
}

export const submit = (h: H, o: Record<string, unknown> = {}) =>
  h.sched.submit({ caller: "orch:x", repo: "o/app", prompt: "do it", ...o }).id;

export const turnEnd = (host: string, thread: string, epoch: number, turn: number, o: Partial<TurnEnd> = {}): TurnEnd => ({
  host, thread, epoch, turn, exitCode: 0, kind: "exited", stderrTail: "",
  result: { isError: false, text: "done", totalCostUsd: 1, durationMs: 5000 }, head: "abc123", pushed: true, pushError: null, memPeakMb: 1000, ...o,
});
