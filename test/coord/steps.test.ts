import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostViews, makeHandler } from "../../src/coord/api";
import { Db } from "../../src/coord/db";
import { summarize } from "../../src/coord/steps";
import { queueText, stepLines } from "../../src/cli/main";
import { harness, ready, submit, turnEnd } from "./helpers";

// Shapes as real claude writes them: "type" late in a result line, tool_use inside an assistant message.
const assistant = (...content: unknown[]) => JSON.stringify({ message: { model: "m", id: "x", type: "message", role: "assistant", content }, type: "assistant", session_id: "s" });
const toolUse = (name: string, input: unknown) => ({ type: "tool_use", id: "toolu_1", name, input });
const toolResult = (content: unknown, is_error = false) => JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content, is_error }] } });

describe("summarize", () => {
  test("tool calls by their main input, text on one line, results, the end and the start", () => {
    expect(summarize(assistant(toolUse("Bash", { command: "bun test\n  --bail", description: "run tests" })))).toEqual(["Bash: bun test --bail"]);
    expect(summarize(assistant(toolUse("Edit", { file_path: "src/a.ts", old_string: "x" }), { type: "text", text: "Now\nthe tests." }))).toEqual(["Edit: src/a.ts", "Now the tests."]);
    expect(summarize(assistant(toolUse("TodoWrite", { todos: [] })))).toEqual(['TodoWrite: {"todos":[]}']);
    expect(summarize(assistant({ type: "thinking", thinking: "hmm" }))).toEqual([]);
    expect(summarize(toolResult("12 pass\n0 fail"))).toEqual(["↳ 12 pass 0 fail"]);
    expect(summarize(toolResult([{ type: "text", text: "no such file" }], true))).toEqual(["↳ error: no such file"]);
    expect(summarize(JSON.stringify({ duration_ms: 1, subtype: "success", type: "result", is_error: false, result: "All done." }))).toEqual(["done: All done."]);
    expect(summarize(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }))).toEqual(["session started"]);
    expect(summarize(JSON.stringify({ type: "rate_limit_event" }))).toEqual([]);
    expect(summarize(assistant({ type: "text", text: "y".repeat(500) }))[0]).toHaveLength(140);
  });

  test("pi events: tool start, tool result, final message, turn end", () => {
    expect(summarize(JSON.stringify({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" }))).toEqual(["bash: …"]);
    expect(summarize(JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hello\n" }] } }))).toEqual(["↳ hello"]);
    expect(summarize(JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "nope" }] } }))).toEqual(["↳ error: nope"]);
    expect(summarize(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Looking\nat src" }] } }))).toEqual(["Looking at src"]);
    expect(summarize(JSON.stringify({ type: "message_end", message: { role: "system", content: [] } }))).toEqual([]);
    expect(summarize(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "All done." }], stopReason: "stop" } }))).toEqual(["done: All done."]);
    expect(summarize(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Too long." }], stopReason: "length" } }))).toEqual(["done (length): Too long."]);
  });

  test("a line the agent cut at 8000 chars still names its tool call; other cut lines are skipped", () => {
    const cut = assistant(toolUse("Write", { file_path: "big.ts", content: "z".repeat(9000) })).slice(0, 8000);
    expect(summarize(cut)).toEqual(["Write: big.ts"]);
    expect(summarize(assistant(toolUse("Write", { content: "z".repeat(9000), file_path: "late.ts" })).slice(0, 8000))).toEqual(["Write: …"]);
    expect(summarize(toolResult("q".repeat(9000)).slice(0, 8000))).toEqual([]);
  });
});

describe("steps of a turn", () => {
  async function running() {
    const h = harness();
    await ready(h, ["a"]);
    const id = submit(h, { tag: "T" });
    await h.sched.tick();
    let off = 0;
    const send = (lines: string[]) => {
      const next = off + lines.join("\n").length + 1;
      expect(h.sched.onEvents({ host: "a", thread: id, epoch: 1, turn: 1, offset: off, lines, nextOffset: next })).toEqual({ committed: next });
      off = next;
    };
    return { h, id, send };
  }

  test("GET /threads/:id/steps: the latest n in order, then only newer ones after `next`; the queue shows the latest call or text", async () => {
    const { h, id, send } = await running();
    send([JSON.stringify({ type: "system", subtype: "init" }), assistant(toolUse("Read", { file_path: "a.ts" }))]);
    h.advance(1000);
    send([toolResult("file body"), assistant({ type: "text", text: "Found it." }, toolUse("Bash", { command: "bun test" }))]);
    const handle = makeHandler(h.sched, h.reports);
    const get = async (q: string) => (await handle(new Request(`http://x/threads/${id}/steps${q}`, { headers: { authorization: "Bearer ct" } }))).json() as any;
    const all = await get("");
    expect(all).toMatchObject({ thread: id, turn: 1, running: true });
    expect(all.steps.map((s: any) => s.text)).toEqual(["session started", "Read: a.ts", "↳ file body", "Found it.", "Bash: bun test"]);
    expect(all.steps[4].at - all.steps[0].at).toBe(1000);
    expect((await get("?n=2")).steps.map((s: any) => s.text)).toEqual(["Found it.", "Bash: bun test"]);
    expect((await get(`?after=${all.next}`)).steps).toEqual([]);
    send([toolResult("3 pass")]);
    const newer = await get(`?after=${all.next}`);
    expect(newer.steps.map((s: any) => s.text)).toEqual(["↳ 3 pass"]);
    expect(newer.next).toBeGreaterThan(all.next);

    const q = h.sched.queue(hostViews(h.sched));
    expect(q.hosts.find((x) => x.name === "a")!.threads[0].activity).toMatchObject({ text: "Bash: bun test" });   // results are not activity
    expect(queueText(q)).toMatch(/turn 1 {2}\S+\n {6}\S+ ago: Bash: bun test/);
    expect(stepLines(newer)[0]).toMatch(/^\d\d:\d\d:\d\d {2}↳ 3 pass$/);

    h.sched.onTurnEnd(turnEnd("a", id, 1, 1));
    expect((await get("")).running).toBe(false);
    expect((await (handle(new Request(`http://x/threads/${id}/steps?turn=9`, { headers: { authorization: "Bearer ct" } })))).status).toBe(404);
    expect((await (handle(new Request(`http://x/threads/nope/steps`, { headers: { authorization: "Bearer ct" } })))).status).toBe(404);
  });

  test("a database from before the events.at column gets it on open; its old rows have no time", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-db-")), file = join(dir, "wd.sqlite");
    try {
      const old = new Database(file);
      old.exec(`CREATE TABLE events(thread TEXT, turn INTEGER, "offset" INTEGER, next_offset INTEGER, line TEXT, PRIMARY KEY(thread, turn, "offset"))`);
      old.close();
      const db = new Db(file);
      expect(db.all<{ name: string }>("PRAGMA table_info(events)").map((c) => c.name)).toContain("at");
      new Db(file);   // a second open is fine
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
