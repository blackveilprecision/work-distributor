// `wd <subcommand>`: thin wrapper over the coordinator's caller API.
import { parseArgs } from "node:util";
import { ack, call, loadCfg, qs, reportText, type Cfg } from "./client.ts";
import type { HostView, QueueView, Report, Steps, ThreadView } from "../shared/types.ts";

const USAGE = `usage: wd submit <repo> <prompt...|-> [--ref r] [--model m] [--require label]... [--size small|heavy] [--priority] [--ttl hours] [--tag t] [--branch b]
       wd ls [--all] | status <id> [--full] | send <id> <text...> | cancel <id> | release <id> | hosts [--repo r] | queue [--json]
       wd tail <id> [-n 20] [--turn n] [--follow] [--json]   (what a turn is doing: its tool calls, text and results)
       wd reports [--pending] [--after n] [--wait] [--hook --event SessionStart|UserPromptSubmit] | ack <id>...
       wd repo add <owner/name> [--url u] [--ref main] [--doctor cmd] [--require label]... [--rust] | repo ls | repo rm <id>
       wd coord install <ssh-host|local> [--listen addr]      (the daemon itself: wd coord [--config file])
       wd host install <ssh-host|local> [--name n] [--label l]... [--claude path] [--agent-url u] [--git-token-file f] [--coord-url u --host-token t]
       wd init-local <dir> [--port-base 17780]      (config for a one-machine trial; then run wd coord / wd agent --config ...)
--caller <name> overrides WD_CALLER for any command.
env: WD_URL, WD_TOKEN, WD_CALLER (or ~/.config/wd/client.json {url, token, caller}; WD_CLIENT_CONFIG names another file)`;

const OPTS = {
  ref: { type: "string" }, model: { type: "string" }, require: { type: "string", multiple: true }, size: { type: "string" },
  priority: { type: "boolean" }, ttl: { type: "string" }, tag: { type: "string" }, branch: { type: "string" }, all: { type: "boolean" },
  pending: { type: "boolean" }, wait: { type: "boolean" }, caller: { type: "string" }, hook: { type: "boolean" }, event: { type: "string" }, after: { type: "string" },
  name: { type: "string" }, "coord-url": { type: "string" }, "host-token": { type: "string" }, "git-token-file": { type: "string" }, claude: { type: "string" }, label: { type: "string", multiple: true },
  url: { type: "string" }, doctor: { type: "string" }, rust: { type: "boolean" }, listen: { type: "string" }, "agent-url": { type: "string" }, "port-base": { type: "string" }, json: { type: "boolean" }, full: { type: "boolean" }, repo: { type: "string" },
  n: { type: "string", short: "n" }, turn: { type: "string" }, follow: { type: "boolean", short: "f" },
} as const;

const json = (v: unknown) => console.log(JSON.stringify(v));
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`; };

const clock = (t: number) => (t ? new Date(t).toTimeString().slice(0, 8) : "--:--:--");
export const stepLines = (r: Steps) => r.steps.map((s) => `${clock(s.at)}  ${s.text}`);

// Follows the thread's latest turn until it ends; a follow-up turn that starts meanwhile is followed too.
async function tail(cfg: Cfg, id: string, v: { n?: string; turn?: string; follow?: boolean; json?: boolean }) {
  const get = (q: Record<string, string | number | undefined>): Promise<Steps> => call(cfg, "GET", `/threads/${id}/steps${qs(q)}`);
  let r = await get({ n: v.n ?? 20, turn: v.turn });
  if (v.json && !v.follow) return json(r);
  console.log(`-- ${id} turn ${r.turn}${r.running ? " (running)" : ""} --`);
  for (const l of stepLines(r)) console.log(l);
  while (v.follow && r.running) {
    await Bun.sleep(2000);
    const n = await get({ after: r.next, n: 500, turn: r.turn });
    for (const l of stepLines(n)) console.log(l);
    r = n;
    if (!r.running && !v.turn) {
      const latest = await get({ n: 1 });
      if (latest.turn !== r.turn) { r = await get({ turn: latest.turn, n: 500 }); console.log(`-- turn ${r.turn} --`); for (const l of stepLines(r)) console.log(l); }
    }
  }
  if (v.follow) console.log(`-- turn ${r.turn} ended --`);
}

export function queueText(q: QueueView): string {
  const out: string[] = [];
  if (q.holdUntil) out.push(`usage-limit hold until ${new Date(q.holdUntil).toISOString()}`);
  out.push(`queued (${q.queued.length})`);
  for (const t of q.queued) out.push(`  ${[t.id, t.repo, t.tag ?? "-", t.caller, ago(t.since), t.priority ? "priority" : "", t.waiting ?? "starting"].filter(Boolean).join("  ")}`);
  if (q.followUps.length) out.push(`follow-ups (${q.followUps.length})`);
  for (const t of q.followUps) out.push(`  ${[t.id, t.host ?? "-", t.tag ?? "-", `${t.count} send${t.count > 1 ? "s" : ""}`, ago(t.since), t.waiting ?? "starting"].join("  ")}`);
  if (q.idle?.length) out.push(`idle (${q.idle.length})`);
  for (const t of q.idle ?? []) out.push(`  ${[t.id, t.host ?? "-", t.tag ?? "-", `${t.turns} turn${t.turns === 1 ? "" : "s"}`, ago(t.since)].join("  ")}`);
  out.push("hosts");
  for (const h of q.hosts) {
    out.push(`  ${[h.name, h.state, `${h.running}/${h.maxThreads}`, `mem=${h.memAvailMb}/${h.memTotalMb}MB`, `disk=${h.diskFreePct}%`, h.reason ?? ""].join("  ").trimEnd()}`);
    for (const t of h.threads) {
      out.push(`    ${[t.id, t.repo, t.tag ?? "-", t.caller, `turn ${t.turn}`, ago(t.startedAt)].join("  ")}`);
      if (t.activity) out.push(`      ${t.activity.at ? `${ago(t.activity.at)} ago` : "earlier"}: ${t.activity.text}`);
    }
  }
  return out.join("\n");
}

// The hook must never block the user's prompt: any failure prints nothing and exits 0.
async function hook(cfg: Cfg, event: string, after?: string): Promise<void> {
  try {
    const reports: Report[] = await call(cfg, "GET", `/reports${qs({ caller: cfg.caller, after })}`, undefined, 3000);
    if (!reports?.length) return;
    const ctx = `wd reports for ${cfg.caller} (already acknowledged; no wd_ack needed):\n\n` + reports.map(reportText).join("\n\n");
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: ctx } }));
    await Promise.all(reports.map((r) => ack(cfg, r.id, 3000).catch(() => {})));
  } catch {}
}

// Blocks until the caller has an unacknowledged report. Polling rides out coordinator restarts; nothing is acked,
// so a watcher that is killed and restarted never loses a report.
export async function waitReports(cfg: Cfg, after?: string, everyMs = 2000): Promise<Report[]> {
  for (;;) {
    try {
      const r: Report[] = await call(cfg, "GET", `/reports${qs({ caller: cfg.caller, after })}`, undefined, 5000);
      if (r?.length) return r;
    } catch (e) {
      if (/: 40[0-4] /.test((e as Error).message)) throw e;
    }
    await Bun.sleep(everyMs);
  }
}

export async function cliMain(argv: string[]): Promise<number> {
  const isHook = argv.includes("--hook");
  if (!argv.length || ["--help", "-h", "help"].includes(argv[0])) { console.log(USAGE); return 0; }
  try {
    const { values: v, positionals: [cmd, ...p] } = parseArgs({ args: argv, options: OPTS, allowPositionals: true });
    const cfg = loadCfg();
    if (v.caller) cfg.caller = v.caller;
    switch (cmd) {
      case "submit": {
        const [repo, ...rest] = p;
        const prompt = rest.join(" ") === "-" ? await Bun.stdin.text() : rest.join(" ");
        if (!repo || !prompt.trim()) throw new Error("submit needs <repo> and a prompt");
        json(await call(cfg, "POST", "/threads", {
          caller: cfg.caller, repo, prompt, ref: v.ref, model: v.model, requires: v.require, size: v.size, priority: v.priority,
          ttlHours: v.ttl ? Number(v.ttl) : undefined, tag: v.tag, branch: v.branch,
        }));
        return 0;
      }
      case "ls":
        for (const t of (await call(cfg, "GET", `/threads${qs({ caller: v.all ? undefined : cfg.caller })}`)) as ThreadView[])
          console.log([t.id, t.state, t.host ?? "-", t.repo, t.branch, t.tag ?? "", t.reason ?? ""].join("\t"));
        return 0;
      case "status": json(await call(cfg, "GET", `/threads/${need(p[0])}${v.full ? "?full=1" : ""}`)); return 0;
      case "send": json(await call(cfg, "POST", `/threads/${need(p[0])}/send`, { text: p.slice(1).join(" ") })); return 0;
      case "cancel":
      case "release": json(await call(cfg, "POST", `/threads/${need(p[0])}/${cmd}`)); return 0;
      case "hosts":
        for (const h of (await call(cfg, "GET", `/hosts${v.repo ? qs({ repo: v.repo }) : ""}`)) as HostView[])
          console.log([h.name, h.state, `run=${h.running}/${h.maxThreads}`, `mem=${h.memAvailMb}/${h.memTotalMb}MB`, `disk=${h.diskFreePct}%`,
            ...(v.repo ? [h.why ? `${v.repo}: ${h.why}` : `${v.repo}: eligible`] : []),
            h.reason ?? "", h.doctorFailed?.length ? `doctor fails: ${h.doctorFailed.join(",")}` : ""].filter(Boolean).join("\t"));
        return 0;
      case "queue": {
        const q: QueueView = await call(cfg, "GET", "/queue");
        if (v.json) json(q); else console.log(queueText(q));
        return 0;
      }
      case "tail": await tail(cfg, need(p[0]), v); return 0;
      case "reports":
        if (v.hook) { await hook(cfg, v.event ?? "UserPromptSubmit", v.after); return 0; }
        json(v.wait ? await waitReports(cfg, v.after) : await call(cfg, "GET", `/reports${qs({ caller: cfg.caller, after: v.after })}`));
        return 0;
      case "ack": for (const id of p) await ack(cfg, Number(id)); return 0;
      case "repo": {
        const id = p[1] && encodeURIComponent(p[1]);
        if (p[0] === "add" && id) {
          const r = await call(cfg, "PUT", `/repos/${id}`, { url: v.url ?? `https://github.com/${p[1]}.git`, defaultRef: v.ref, doctor: v.doctor, requires: v.require, rust: v.rust });
          json(r);
          if (r.source === "config") console.error(`wd: ${p[1]} is defined in coord.json, which wins: nothing was changed`);
        } else if (p[0] === "rm" && id) json(await call(cfg, "DELETE", `/repos/${id}`));
        else if (p[0] === "ls") for (const r of (await call(cfg, "GET", "/repos")) as any[])
          console.log([r.id, r.url, r.defaultRef, r.doctor ?? "", r.requires.join(","), r.rust ? "rust" : "", r.source].join("\t"));
        else throw new Error("usage: wd repo add <owner/name> [...] | repo ls | repo rm <id>");
        return 0;
      }
      case "coord": {
        if (p[0] !== "install" || !p[1]) throw new Error("usage: wd coord install <ssh-host|local> [--listen addr]");
        await (await import("./install.ts")).coordInstall(p[1], { listen: v.listen });
        return 0;
      }
      case "host": {
        if (p[0] !== "install" || !p[1]) throw new Error("usage: wd host install <ssh-host|local> [options]");
        await (await import("./install.ts")).hostInstall({
          host: p[1], name: v.name, coordUrl: v["coord-url"], hostToken: v["host-token"], gitTokenFile: v["git-token-file"], labels: v.label, claude: v.claude, agentUrl: v["agent-url"] });
        return 0;
      }
      case "init-local":
        if (!p[0]) throw new Error("usage: wd init-local <dir> [--port-base 17780]");
        (await import("./install.ts")).initLocal(p[0], v["port-base"] ? Number(v["port-base"]) : undefined);
        return 0;
      default: console.error(USAGE); return cmd ? 2 : 0;
    }
  } catch (e) {
    if (isHook) return 0;
    console.error(`wd: ${(e as Error).message}`);
    return 1;
  }
}

function need(s: string | undefined): string {
  if (!s) throw new Error("missing thread id");
  return s;
}
