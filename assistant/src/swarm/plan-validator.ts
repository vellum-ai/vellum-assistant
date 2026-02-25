import { detectCycles } from './graph-utils.js';
import type { SwarmLimits } from './limits.js';
import type { SwarmPlan, SwarmTaskNode } from './types.js';
import { VALID_SWARM_ROLES } from './types.js';

export class SwarmPlanValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message);
    this.name = 'SwarmPlanValidationError';
  }
}

/**
 * Validate and normalize a swarm plan. Returns the validated plan or throws
 * SwarmPlanValidationError with all detected issues.
 */
export function validateAndNormalizePlan(
  plan: SwarmPlan,
  limits: SwarmLimits,
): SwarmPlan {
  const issues: string[] = [];

  // --- Basic structure ---
  if (!plan.objective || typeof plan.objective !== 'string') {
    issues.push('Plan must have a non-empty objective string.');
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    issues.push('Plan must have at least one task.');
    throw new SwarmPlanValidationError('Plan validation failed', issues);
  }

  // --- Normalize dependencies early (before any checks that iterate them) ---
  let tasks: SwarmTaskNode[] = plan.tasks.map((t) => ({
    ...t,
    dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
  }));
  const originalIds = new Set(tasks.map((task) => task.id));

  // --- Task count limit ---
  if (tasks.length > limits.maxTasks) {
    console.warn(`Plan truncated from ${tasks.length} tasks to ${limits.maxTasks}`);
    tasks = tasks.slice(0, limits.maxTasks);
  }

  // --- Unique IDs ---
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.id || typeof task.id !== 'string') {
      issues.push(`Task has invalid or empty id.`);
      continue;
    }
    if (ids.has(task.id)) {
      issues.push(`Duplicate task id: "${task.id}".`);
    }
    ids.add(task.id);
  }

  // --- Valid roles ---
  for (const task of tasks) {
    if (!VALID_SWARM_ROLES.includes(task.role)) {
      issues.push(
        `Task "${task.id}" has invalid role "${task.role}". Valid roles: ${VALID_SWARM_ROLES.join(', ')}.`,
      );
    }
  }

  // --- Strip orphaned dependency references (from truncation) and report real errors ---
  for (const task of tasks) {
    const valid: string[] = [];
    for (const dep of task.dependencies) {
      if (!ids.has(dep)) {
        if (!originalIds.has(dep)) {
          issues.push(`Task "${task.id}" depends on unknown task "${dep}".`);
        }
      } else {
        valid.push(dep);
      }
    }
    task.dependencies = valid;
  }

  // --- Cycle detection (Kahn's algorithm) ---
  if (!hasDuplicateIds(tasks) && issues.length === 0) {
    const cycleNodes = detectCycles(tasks);
    if (cycleNodes) {
      issues.push(`Plan contains a dependency cycle: ${cycleNodes.join(' -> ')}.`);
    }
  }

  if (issues.length > 0) {
    throw new SwarmPlanValidationError('Plan validation failed', issues);
  }

  return { ...plan, tasks };
}

function hasDuplicateIds(tasks: SwarmTaskNode[]): boolean {
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) return true;
    seen.add(t.id);
  }
  return false;
}

