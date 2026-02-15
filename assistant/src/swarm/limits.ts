/**
 * Runtime limits for swarm execution, resolved from config.
 */

export interface SwarmLimits {
  maxWorkers: number;
  maxTasks: number;
  maxRetriesPerTask: number;
  workerTimeoutSec: number;
}

/** Hard ceilings that config values are clamped to. */
export const SWARM_HARD_LIMITS = {
  maxWorkers: 6,
  maxTasks: 20,
  maxRetriesPerTask: 3,
} as const;

/**
 * Resolve effective limits from config, clamping to hard ceilings.
 */
export function resolveSwarmLimits(config: {
  maxWorkers: number;
  maxTasks: number;
  maxRetriesPerTask: number;
  workerTimeoutSec: number;
}): SwarmLimits {
  return {
    maxWorkers: Math.min(Math.max(1, config.maxWorkers), SWARM_HARD_LIMITS.maxWorkers),
    maxTasks: Math.min(Math.max(1, config.maxTasks), SWARM_HARD_LIMITS.maxTasks),
    maxRetriesPerTask: Math.min(
      Math.max(0, config.maxRetriesPerTask),
      SWARM_HARD_LIMITS.maxRetriesPerTask,
    ),
    workerTimeoutSec: Math.max(1, config.workerTimeoutSec),
  };
}
