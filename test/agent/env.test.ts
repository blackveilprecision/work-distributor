import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginPath } from "../../src/agent/config";
import { harness, sh, until } from "./harness";

describe("loginPath", () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-shell-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // A stand-in for the user's shell: named bash so it is used, noisy like a real rc file, and it records its flags.
  const shell = (body: string) => {
    const f = join(dir, `${Math.random().toString(36).slice(2)}`, "bash");
    Bun.spawnSync(["mkdir", "-p", join(f, "..")]);
    writeFileSync(f, `#!/bin/sh\necho "$1" > ${JSON.stringify(f + ".flags")}\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };

  test("takes the PATH an interactive login shell prints, ahead of the service's own, ignoring rc noise", async () => {
    const f = shell(`echo "welcome back"; printf '\\n__WD_PATH__=%s\\n' "/home/u/.bun/bin:/usr/bin"; echo "bye"`);
    const p = await loginPath(f);
    expect(p.startsWith("/home/u/.bun/bin:/usr/bin:")).toBe(true);
    for (const d of process.env.PATH!.split(":").filter(Boolean)) expect(p.split(":")).toContain(d);
    expect(p.split(":").filter((d) => d === "/usr/bin")).toHaveLength(1);
    expect(readFileSync(f + ".flags", "utf8").trim()).toBe("-lic");
  });

  test("a shell that fails or prints no marker leaves the service's PATH", async () => {
    expect(await loginPath(shell("exit 3"))).toBe(process.env.PATH!.split(":").filter(Boolean).filter((d, i, a) => a.indexOf(d) === i).join(":"));
  });
});

describe("the agent's PATH reaches the doctor and the turn; the exclude line is written once", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  const PATH = `/opt/only-in-bashrc/bin:${process.env.PATH}`;
  beforeAll(async () => { h = await harness({ path: PATH }); });
  afterAll(() => h.cleanup());

  test("doctor runs with the agent's PATH", async () => {
    const r = await h.call("/doctor", { repoId: "acme/app", repoUrl: h.origin, command: 'printf %s "$PATH"' });
    expect(r.body).toEqual({ ok: true, output: PATH });
  });

  test("turns get it, and two worktrees of one mirror leave one .wd-tmp line in info/exclude", async () => {
    await h.call("/start", h.turn());
    await h.call("/start", h.turn({ thread: "t2", branch: "wd/t2" }));
    await until(() => h.coord.of("/agent/turn-end").length === 2, 20_000, "two turn ends");
    expect(readFileSync(join(h.turnDir(h.turn()), "run.sh"), "utf8")).toContain(`'PATH=${PATH}'`);
    const ex = sh(join(h.cfg.dataDir, "wt/t1"), "git", "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
    expect(readFileSync(ex, "utf8").split("\n").filter((l) => l === ".wd-tmp")).toHaveLength(1);
  });
});
