export type {
  SubagentStatus,
  SubagentConfig,
  SubagentState,
} from './types.js';
export { TERMINAL_STATUSES, SUBAGENT_LIMITS } from './types.js';
export { SubagentManager } from './manager.js';

import { SubagentManager } from './manager.js';

/** Singleton SubagentManager instance shared across the daemon. */
let _instance: SubagentManager | null = null;

export function getSubagentManager(): SubagentManager {
  if (!_instance) {
    _instance = new SubagentManager();
  }
  return _instance;
}
