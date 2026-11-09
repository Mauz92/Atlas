import type { SimConfig } from "./world.ts";

/** A fast network and short steps give the clients throughput: the reminders need real traffic mid-run. */
export const REMINDER_BASE: Partial<SimConfig> = {
  reminders: true, kinds: ["task"], clients: 3, maxLatency: 3, stepMs: 4, timeScale: 0.2, actionP: 0.5, pSlow: 0.03,
};
