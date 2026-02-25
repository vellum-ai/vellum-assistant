/**
 * Runtime limits for swarm execution, resolved from config.
 */

import type { SwarmRole } from './types.js';

export interface SwarmLimits {
  maxWorkers: number;
  maxTasks: number;
  maxRetriesPerTask: number;
  workerTimeoutSec: number;
  /** Per-role timeout overrides. When set, takes precedence over workerTimeoutSec for that role. */
  roleTimeoutsSec: Partial<Record<SwarmRole, number>>;
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
  roleTimeoutsSec?: Partial<Record<SwarmRole, number>>;
}): SwarmLimits {
  const resolvedRoleTimeouts: Partial<Record<SwarmRole, number>> = {};
  if (config.roleTimeoutsSec) {
    for (const [role, timeout] of Object.entries(config.roleTimeoutsSec)) {
      if (timeout != null) {
        resolvedRoleTimeouts[role as SwarmRole] = Math.max(1, timeout);
      }
    }
  }

  return {
    maxWorkers: Math.min(Math.max(1, config.maxWorkers), SWARM_HARD_LIMITS.maxWorkers),
    maxTasks: Math.min(Math.max(1, config.maxTasks), SWARM_HARD_LIMITS.maxTasks),
    maxRetriesPerTask: Math.min(
      Math.max(0, config.maxRetriesPerTask),
      SWARM_HARD_LIMITS.maxRetriesPerTask,
    ),
    workerTimeoutSec: Math.max(1, config.workerTimeoutSec),
    roleTimeoutsSec: resolvedRoleTimeouts,
  };
}

/** Get the effective timeout for a given role, falling back to the global workerTimeoutSec. */
export function getTimeoutForRole(limits: SwarmLimits, role: SwarmRole): number {
  return limits.roleTimeoutsSec[role] ?? limits.workerTimeoutSec;
}
