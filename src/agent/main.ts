import { loadConfig } from "./config";
import { probe } from "./probe";
import { startAgent } from "./server";

// wd agent [--config file]           run the agent
// wd agent probe [--config file]     print what the probe sees and exit 1 when it would refuse the host
export async function agentMain(args: string[]): Promise<number> {
  const at = args.indexOf("--config");
  const cfg = loadConfig(at >= 0 ? args[at + 1] : undefined);
  if (args[0] === "probe") {
    const p = await probe(cfg);
    console.log(JSON.stringify(p, null, 2));
    return p.problems.length ? 1 : 0;
  }
  const agent = await startAgent(cfg);
  console.log(`wd agent ${cfg.name} listening on ${cfg.listen}, ${agent.ctx.active.size} turn(s) resumed`);
  const stopped = new Promise<void>((resolve) => { for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => resolve()); });
  await stopped;
  await agent.close();
  return 0;
}
