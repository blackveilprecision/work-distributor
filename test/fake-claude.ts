#!/usr/bin/env bun
// Imitates `claude -p --output-format stream-json --verbose`. Behaviour is chosen by keywords in the prompt:
//   SLEEP:<s>   wait s seconds after the first message     TICK:<n>   n assistant lines, 100 ms apart
//   FAIL        result is_error=true, exit 1                COMMIT     create and commit a file in cwd
//   DIRTY       leave an uncommitted file in cwd            BIGLINE    one 10 MB assistant line
// Cost is cumulative per session across --resume, like the real total_cost_usd. A file named .fake-claude-nologin in
// $HOME makes every call answer "Not logged in".
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const val = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.includes("--version")) { console.log(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.0"} (Claude Code)`); process.exit(0); }

const format = val("--output-format") ?? "text";
const resume = val("--resume"), sessionId = resume ?? val("--session-id") ?? crypto.randomUUID();
// the prompt is the positional argument when there is one, else stdin
const flagsWithValue = new Set(["--output-format", "--session-id", "--resume", "--setting-sources", "--settings", "--model", "--max-turns"]);
const positional = argv.find((a, i) => !a.startsWith("-") && !flagsWithValue.has(argv[i - 1] ?? ""));
const prompt = positional ?? (await Bun.stdin.text());
const started = Date.now();
const emit = (o: unknown) => format === "stream-json" && process.stdout.write(JSON.stringify(o) + "\n");
const out: unknown[] = [];
const say = (text: string) => { const e = { type: "assistant", message: { id: crypto.randomUUID(), role: "assistant", model: "fake", content: [{ type: "text", text }] }, session_id: sessionId }; out.push(e); emit(e); };
const done = (isError: boolean, text: string, cost: number, code = 0): never => {
  // Key order copies real claude 2.1.32x, which puts "type" late: parsers must not rely on it being first.
  const r = { duration_ms: Date.now() - started, subtype: isError ? "error" : "success", type: "result", is_error: isError, duration_api_ms: 1, num_turns: 1, result: text, session_id: sessionId, total_cost_usd: cost, credential_expires_at: Date.now() + 30 * 86400_000 };
  if (format === "stream-json") emit(r); else console.log(JSON.stringify(r));
  process.exit(code);
};

if (existsSync(join(process.env.HOME ?? "/nonexistent", ".fake-claude-nologin"))) done(true, "Not logged in · Please run /login", 0, 1);

const state = join(tmpdir(), `fake-claude-session-${sessionId}.json`);
if (resume && !existsSync(state)) done(true, `No conversation found with session ID: ${resume}`, 0, 1);
const prior = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : { turns: 0, cost: 0 };
const cost = prior.cost + 0.02;
writeFileSync(state, JSON.stringify({ turns: prior.turns + 1, cost }));

emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), model: val("--model") ?? "fake", tools: [] });
say(`working on: ${prompt.slice(0, 60)}`);

const kw = (name: string) => new RegExp(`${name}(?::(\\d+(?:\\.\\d+)?))?`).exec(prompt);
if (kw("COMMIT")) {
  const f = `fake-${prior.turns + 1}.txt`;
  await Bun.write(f, `turn ${prior.turns + 1}\n`);
  for (const a of [["add", f], ["-c", "user.name=fake", "-c", "user.email=fake@x", "commit", "-qm", `fake commit ${f}`]]) Bun.spawnSync(["git", ...a]);
}
if (kw("DIRTY")) await Bun.write("dirty.txt", "left behind\n");
// A child in a process group of its own, as Claude Code's Bash tool runs every command; its pid goes to group-child.pid.
if (kw("GROUPCHILD")) {
  const c = Bun.spawn(["/bin/sh", "-c", "exec sleep 300"], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
  await Bun.write("group-child.pid", String(c.pid));
}
if (kw("BIGLINE")) say("x".repeat(10 * 1024 * 1024));
const tick = kw("TICK");
if (tick) for (let i = 0; i < Number(tick[1]); i++) { say(`tick ${i}`); await Bun.sleep(100); }
const sleep = kw("SLEEP");
if (sleep) await Bun.sleep(Number(sleep[1]) * 1000);
if (kw("FAIL")) done(true, "fake failure", cost, 1);
done(false, `fake done (turn ${prior.turns + 1})`, cost);
