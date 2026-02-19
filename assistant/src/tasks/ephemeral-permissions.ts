import type { TrustRule } from '../permissions/types.js';

// In-memory map: task_run_id -> ephemeral rules
const activeTaskRules = new Map<string, TrustRule[]>();

/** Register ephemeral permission rules for a task run. */
export function setTaskRunRules(taskRunId: string, rules: TrustRule[]): void {
  activeTaskRules.set(taskRunId, rules);
}

/** Get ephemeral rules for a task run (returns empty array if none). */
export function getTaskRunRules(taskRunId: string): TrustRule[] {
  return activeTaskRules.get(taskRunId) ?? [];
}

/** Remove ephemeral rules when a task run ends. */
export function clearTaskRunRules(taskRunId: string): void {
  activeTaskRules.delete(taskRunId);
}

/**
 * Build ephemeral TrustRule entries from a task's required_tools list.
 *
 * Each rule allows the specified tool with a wildcard pattern scoped to the
 * given working directory. Priority is set to 50 — lower than user rules (100)
 * so that user deny rules still take precedence. `allowHighRisk` is set because
 * task sessions have no client to respond to confirmation prompts — without it,
 * high-risk tools hang indefinitely waiting for approval that never comes.
 */
export function buildTaskRules(taskRunId: string, requiredTools: string[], workingDir: string): TrustRule[] {
  return requiredTools.map((tool) => ({
    id: `ephemeral:${taskRunId}:${tool}`,
    tool,
    pattern: '**',
    scope: workingDir,
    decision: 'allow' as const,
    allowHighRisk: true,
    priority: 50,
    createdAt: Date.now(),
    principalKind: 'task',
    principalId: taskRunId,
  }));
}
