import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../../src/agent/config";
import { probe, resetLoginCache } from "../../src/agent/probe";

test("a slow login check never holds a heartbeat's probe: it finishes in the background and a later probe has it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-probe-"));
  const claude = join(dir, "claude");
  writeFileSync(claude, `#!/bin/sh\n[ "$1" = --version ] && { echo "2.1.0 (Claude Code)"; exit 0; }\nsleep 1.5\necho '{"type":"result","is_error":false,"result":"ok"}'\n`, { mode: 0o755 });
  const cfg = { claude, dataDir: join(dir, "data") } as AgentConfig;
  resetLoginCache();
  try {
    const t0 = Date.now();
    const first = await probe(cfg, 200);
    expect(Date.now() - t0).toBeLessThan(1400);
    expect(first).toMatchObject({ loginOk: false, loginError: "claude login check still running" });
    await Bun.sleep(1800);
    expect(await probe(cfg, 200)).toMatchObject({ loginOk: true, loginError: null });
  } finally { resetLoginCache(); }
});
