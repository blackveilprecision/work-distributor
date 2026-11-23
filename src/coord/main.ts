import { loadConfig } from "./config";
import { Db } from "./db";
import { Reports } from "./reports";
import { httpAgent, Scheduler } from "./scheduler";
import { startApi } from "./api";

// wd coord [--config file]
export async function coordMain(args: string[]): Promise<void> {
  const at = args.indexOf("--config");
  const cfg = loadConfig(at >= 0 ? args[at + 1] : undefined);
  const db = new Db(cfg.db);
  const reports = new Reports(db);
  const sched: Scheduler = new Scheduler(db, cfg, httpAgent((n) => sched.hostCfg(n)), reports);
  const server = startApi(sched, reports);
  console.log(`wd-coord listening on ${server.hostname}:${server.port}, db ${cfg.db}`);
  setInterval(() => void sched.tick(), cfg.tickMs);
  await new Promise<void>(() => {});   // serve until killed
}
