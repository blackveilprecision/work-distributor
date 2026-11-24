import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compiled, replaceBinary } from "../../src/agent/update";
import { newer } from "../../src/shared/version";

let stops: (() => void)[] = [];
afterEach(() => { stops.forEach((f) => f()); stops = []; });

// A release server whose "binary" is a shell script printing a version.
function releases(prints: string) {
  const s = Bun.serve({ port: 0, fetch: (req) => new URL(req.url).pathname === "/v9.9.9/wd-linux-x64"
    ? new Response(`#!/bin/sh\necho ${prints}\n`) : new Response("no", { status: 404 }) });
  stops.push(() => s.stop(true));
  return `http://127.0.0.1:${s.port}`;
}

test("versions compare numerically", () => {
  expect(newer("0.10.0", "0.9.9")).toBe(true);
  expect(newer("0.2.0", "0.2.0")).toBe(false);
  expect(newer("0.1.9", "0.2.0")).toBe(false);
});

test("only a compiled wd updates itself", () => {
  expect(compiled("/home/u/.bun/bin/bun")).toBe(false);
  expect(compiled("/home/u/.local/bin/wd")).toBe(true);
});

test("the release replaces the binary only once it reports the right version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-upd-")), exe = join(dir, "wd");
  writeFileSync(exe, "old");
  await expect(replaceBinary("9.9.9", exe, "linux", "x64", releases("9.9.8"))).rejects.toThrow("not 9.9.9");
  expect(readFileSync(exe, "utf8")).toBe("old");
  await expect(replaceBinary("9.9.9", exe, "darwin", "arm64", releases("9.9.9"))).rejects.toThrow("404");
  expect(readFileSync(exe, "utf8")).toBe("old");
  await replaceBinary("9.9.9", exe, "linux", "x64", releases("9.9.9"));
  expect(Bun.spawnSync([exe]).stdout.toString().trim()).toBe("9.9.9");
});
