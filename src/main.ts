#!/usr/bin/env bun
// One binary: the CLI, the installers and the daemons (`wd coord`, `wd agent`, `wd mcp`). `wd --help` lists them all.
export {};
const argv = process.argv.slice(2);
if (argv.length === 1 && ["--version", "-V", "version"].includes(argv[0])) console.log((await import("./shared/version.ts")).VERSION);
else process.exitCode = await (await import("./cli/main.ts")).cliMain(argv);
