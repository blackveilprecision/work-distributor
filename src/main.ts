#!/usr/bin/env bun
// One binary: `wd coord`, `wd agent`, `wd mcp`, otherwise a CLI subcommand.
export {};
const [cmd, ...rest] = process.argv.slice(2);

switch (cmd === "coord" && rest[0] === "install" ? "cli" : cmd) {   // `wd coord install` is a CLI command, `wd coord` the daemon
  case "coord":
    await (await import("./coord/main.ts")).coordMain(rest);
    break;
  case "agent":
    await (await import("./agent/main.ts")).agentMain(rest);
    break;
  case "mcp":
    await (await import("./mcp/server.ts")).mcpMain(rest);
    break;
  default:
    process.exitCode = await (await import("./cli/main.ts")).cliMain(cmd ? [cmd, ...rest] : []);
}
