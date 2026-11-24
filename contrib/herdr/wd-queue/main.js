// wd's queue across every caller: what waits for a host (and why), what runs on each host and what it is doing, and what
// sits idle. Shown in the right-hand panel like Files and Changes (the tab bar's "wd" button). Reads `wd queue --json`
// (the coordinator's GET /queue) every few seconds; wd's own client.json supplies url and token. Clicking a row opens
// more about it: a running thread's recent steps (`wd tail`), a host's eligibility per repo, a follow-up's waiting
// text, a queued prompt, an idle thread's last result.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, checking } from "herdr";

const EVERY_MS = 5000;

const ago = (t) => {
  if (!t) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
};
const repoName = (r) => r.split("/").pop();
const gb = (mb) => `${(mb / 1024).toFixed(1)}G`;
const gbWhole = (mb) => `${Math.round(mb / 1024)}G`;

export default class WdQueue extends View {
  init(_props, cx) {
    this.q = null;
    this.error = null;
    this.open = new Set();     // keys of opened rows: "t:<thread>", "f:<thread>", "q:<thread>", "i:<thread>", "h:<host>", "idle"
    this.steps = new Map();    // thread -> recent steps, for opened running threads and follow-ups
    if (checking()) return;
    cx.timer.every(EVERY_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("wd", ["queue", "--json"], { timeout: 10000 });
        if (r.code === 0) { this.q = JSON.parse(r.stdout); this.error = null; }
        else this.error = (r.stderr || r.stdout).trim().split("\n").pop() || `wd exited ${r.code}`;
        await this.loadSteps();
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.busy = false;
      }
      cx.notify();
    });
  }

  // Steps for every opened running thread or follow-up; whatever is no longer running is dropped.
  async loadSteps() {
    const running = new Set((this.q?.hosts ?? []).flatMap((h) => h.threads.map((r) => r.id)));
    const want = [...this.open].filter((k) => k.startsWith("t:") || k.startsWith("f:")).map((k) => k.slice(2)).filter((id) => running.has(id));
    for (const id of [...this.steps.keys()]) if (!want.includes(id)) this.steps.delete(id);
    for (const id of new Set(want)) {
      const r = await exec("wd", ["tail", id, "-n", "12", "--json"], { timeout: 10000 }).catch(() => null);
      if (r?.code === 0) this.steps.set(id, JSON.parse(r.stdout).steps);
    }
  }

  toggle(key, cx) {
    if (this.open.has(key)) this.open.delete(key); else this.open.add(key);
    cx.notify();
    if (/^[tf]:/.test(key) && this.open.has(key)) cx.spawn(async (cx) => { await this.loadSteps(); cx.notify(); });
  }

  label(t, key, text, n, foldable) {
    const open = !foldable || this.open.has(key);
    return h_flex().id(`l-${key}`).h(26).px(8).gap(6).items_center().text_size(11).text_color(t.dim)
      .when(foldable, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.toggle(key, cx))
        .child(svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(10)))
      .child(text).child(div().text_color(t.muted).child(String(n)));
  }

  // A clickable row: dot, name, a right-hand note and an age.
  row(t, key, dot, name, right, when, tip) {
    const open = this.open.has(key);
    return h_flex().id(`row-${key}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => this.toggle(key, cx))
      .child(div().size(7).flex_none().rounded(4).bg(dot))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).when(open, (el) => el.font_medium()).child(name))
      .when(Boolean(right), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(right)))
      .when(Boolean(when), (el) => el.child(div().flex_none().w(30).text_size(11).text_color(t.dim).text_right().child(when)));
  }

  // Text that wraps, for prompts, messages and results.
  para(t, id, text, color) {
    return div().id(id).ml(23).mr(8).mb(4).px(8).py(6).rounded(6).bg(t.surface).text_size(11.5).text_color(color ?? t.muted).whitespace_normal().child(text);
  }

  stepList(t, id) {
    const steps = this.steps.get(id);
    if (!steps) return [div().id(`s-${id}-l`).pl(23).pb(2).text_size(11).text_color(t.dim).child("loading steps…")];
    return steps.map((s, i) => h_flex().id(`s-${id}-${i}`).pl(23).pr(8).gap(6).text_size(11).tooltip(s.text)
      .child(div().flex_1().min_w(0).truncate().text_color(s.text.startsWith("↳") ? t.dim : t.muted).child(s.text))
      .child(div().flex_none().text_color(t.dim).child(ago(s.at))));
  }

  // A queued thread or a follow-up: the row, why it waits (one line per host reason), and, opened, what it will be told.
  waiting(t, kind, e, right) {
    const key = `${kind}:${e.id}`, open = this.open.has(key);
    const why = e.waiting ? e.waiting.split("; ") : ["starting on the next tick"];
    return v_flex().id(`w-${key}`).rounded(6).when(open, (el) => el.bg(t.raised).pb(4))
      .child(this.row(t, key, e.waiting ? t.idle : t.working, e.tag ?? e.id, right, ago(e.since), `${e.id} · ${e.caller}${e.host ? ` · ${e.host}` : ""}`))
      .children(why.map((w, i) => div().id(`w-${key}-${i}`).pl(23).pr(8).pb(2).text_size(11).text_color(t.dim).truncate().tooltip(w).child(w)))
      .when(open && kind === "q", (el) => el.child(this.para(t, `p-${key}`, e.prompt)))
      .when(open && kind === "f", (el) => el
        .children(e.texts.map((x, i) => this.para(t, `p-${key}-${i}`, x, t.foreground)))
        .children(e.waiting === "current turn still running" ? this.stepList(t, e.id) : []));
  }

  idleRow(t, e) {
    const key = `i:${e.id}`, open = this.open.has(key);
    const first = (e.lastMessage ?? "").split("\n").find((l) => l.trim()) ?? "";
    return v_flex().id(`w-${key}`).rounded(6).when(open, (el) => el.bg(t.raised).pb(4))
      .child(this.row(t, key, t.dim, e.tag ?? e.id, `${e.host ?? "-"} · ${e.turns}t`, ago(e.since), `${e.id} · ${e.caller} · ${e.repo}`))
      .when(!open && Boolean(first), (el) => el.child(div().id(`im-${e.id}`).pl(23).pr(8).pb(2).text_size(11).text_color(t.dim).truncate().child(first)))
      .when(open, (el) => el.child(this.para(t, `p-${key}`, e.lastMessage ?? "(no message)")));
  }

  host(t, h) {
    const key = `h:${h.name}`, open = this.open.has(key), full = h.maxThreads != null && h.running >= h.maxThreads, ok = h.state === "ok";
    const busy = (h.load1 ?? 0) + (h.cpuPromisedCores ?? 0);   // cores in use or promised to running turns
    const dot = !ok ? (h.state === "asleep" ? t.idle : t.blocked) : h.running ? t.working : t.dim;
    const repos = Object.entries(h.repos ?? {});
    return v_flex().id(`h-${h.name}`).rounded(6).when(open, (el) => el.bg(t.raised).pb(4))
      .child(h_flex().id(`hh-${h.name}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggle(key, cx))
        .tooltip(ok ? `CPU ${busy.toFixed(1)} of ${h.cores} cores busy or promised · RAM ${gb(h.memAvailMb)} free of ${gb(h.memTotalMb)} · disk ${h.diskFreePct}% free · click for details` : h.reason ?? h.state)
        .child(div().size(7).flex_none().rounded(4).bg(dot))
        .child(div().text_color(t.foreground).when(open, (el) => el.font_medium()).child(h.name))
        .child(div().text_size(11).text_color(full ? t.blocked : t.muted).child(h.maxThreads == null ? `${h.running}` : `${h.running}/${h.maxThreads}`))
        .child(div().flex_1())
        .when(ok, (el) => el
          .child(div().flex_none().text_size(11).text_color(busy > h.cores ? t.blocked : t.dim).child(`${busy.toFixed(1)}/${h.cores}c`))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${gb(h.memAvailMb)}/${gbWhole(h.memTotalMb)}`))
          .child(div().flex_none().text_size(11).text_color(h.diskFreePct < 20 ? t.blocked : t.dim).child(`${Math.round(h.diskFreePct)}%`)))
        .when(!ok, (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked).child(h.state))))
      .when(open, (el) => el
        .child(div().id(`hd-${h.name}`).pl(23).pr(8).pb(2).text_size(11).text_color(t.dim).truncate()
          .child([h.labels.join(", ") || "no labels", h.cpuScore ? `speed ${h.cpuScore}` : null, h.claudeVersion ? `claude ${h.claudeVersion.split(" ")[0]}` : null, h.lastSeenAt ? `seen ${ago(h.lastSeenAt)} ago` : "never seen"].filter(Boolean).join(" · ")))
        .when(!ok && Boolean(h.reason), (el) => el.child(this.para(t, `hr-${h.name}`, h.reason, t.blocked)))
        .children(repos.map(([r, why]) => h_flex().id(`he-${h.name}-${r}`).pl(23).pr(8).gap(6).text_size(11).tooltip(why ?? "a new thread of this repo could start here now")
          .child(div().flex_none().text_color(t.muted).child(repoName(r)))
          .child(div().flex_1().min_w(0).truncate().text_color(why ? (why.startsWith("doctor failed") || why.startsWith("lacks") ? t.blocked : t.dim) : t.done)
            .child(why ?? "eligible")))))
      .children(h.threads.map((r) => this.thread(t, r)));
  }

  // A running thread: its row, what it did last, and (opened) its recent steps.
  thread(t, r) {
    const key = `t:${r.id}`, open = this.open.has(key);
    return v_flex().id(`t-${r.id}`).rounded(6).when(open, (el) => el.bg(t.raised).pb(4))
      .child(h_flex().id(`r-${r.id}`).h(24).pl(23).pr(8).gap(8).items_center().text_size(12).rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggle(key, cx))
        .tooltip(`${r.id} · ${r.caller} · ${r.repo} · turn ${r.turn} · click for recent steps`)
        .child(div().flex_1().min_w(0).truncate().text_color(open ? t.foreground : t.muted).child(r.tag ?? r.id))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(repoName(r.repo)))
        .child(div().flex_none().w(30).text_size(11).text_color(t.dim).text_right().child(ago(r.startedAt))))
      .when(!open && Boolean(r.activity), (el) => el.child(h_flex().id(`a-${r.id}`).pl(23).pr(8).pb(3).gap(6).text_size(11).tooltip(r.activity.text)
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(r.activity.text))
        .child(div().flex_none().text_color(t.dim).child(ago(r.activity.at)))))
      .when(open, (el) => el.children(this.stepList(t, r.id)));
  }

  render() {
    const t = theme(), q = this.q;
    const running = q ? q.hosts.reduce((n, h) => n + h.running, 0) : 0;
    const root = v_flex().id("wd-queue").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13);
    const head = h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
      .child(div().text_size(11.5).font_medium().text_color(t.dim).child("wd queue"))
      .child(div().id("wd-summary").text_size(11).text_color(this.error ? t.blocked : t.dim).tooltip(this.error ?? "")
        .child(this.error ? "unreachable" : q ? `${running} running · ${q.queued.length} queued${q.idle?.length ? ` · ${q.idle.length} idle` : ""}` : "…"));
    const list = v_flex().id("wd-list").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar();
    if (!q) return root.child(head).child(list.child(div().px(8).text_size(12).text_color(t.dim).child(this.error ?? "Loading…")));
    if (q.holdUntil) list.child(div().mx(8).mb(4).px(8).py(4).rounded(6).bg(t.blocked + "26").text_size(11).text_color(t.blocked)
      .child(`Usage-limit hold until ${new Date(q.holdUntil).toLocaleTimeString()}`));
    if (q.queued.length) {
      list.child(this.label(t, "queued", "Queued", q.queued.length, false));
      for (const e of q.queued) list.child(this.waiting(t, "q", e, `${repoName(e.repo)}${e.priority ? " · prio" : ""}`));
    }
    if (q.followUps.length) {
      list.child(this.label(t, "followups", "Follow-ups", q.followUps.length, false));
      for (const e of q.followUps) list.child(this.waiting(t, "f", e, `${e.count} send${e.count > 1 ? "s" : ""}`));
    }
    list.child(this.label(t, "hosts", "Hosts", q.hosts.length, false));
    for (const h of q.hosts) list.child(this.host(t, h));
    if (q.idle?.length) {
      list.child(this.label(t, "idle", "Idle", q.idle.length, true));
      if (this.open.has("idle")) for (const e of q.idle) list.child(this.idleRow(t, e));
    }
    return root.child(head).child(list);
  }
}
