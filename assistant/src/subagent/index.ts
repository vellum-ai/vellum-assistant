export { SubagentManager } from "./manager.js";
export type { SubagentConfig, SubagentState, SubagentStatus } from "./types.js";
export { SUBAGENT_LIMITS, TERMINAL_STATUSES } from "./types.js";

import { SubagentManager } from "./manager.js";

/** Singleton SubagentManager instance shared across the daemon. */
let _instance: SubagentManager | null = null;

export function getSubagentManager(): SubagentManager {
  if (!_instance) {
    _instance = new SubagentManager();
  }
  return _instance;
}
