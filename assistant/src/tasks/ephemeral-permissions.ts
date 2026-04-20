import { SCOPED_TOOLS } from "@vellumai/ces-contracts";

import type { TrustRule } from "../permissions/types.js";

/** O(1) lookup set for scoped tool names. */
const SCOPED_TOOLS_SET: ReadonlySet<string> = new Set(SCOPED_TOOLS);

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
 * Each rule allows the specified tool with a wildcard pattern scoped
 * globally ('everywhere'). The scope is intentionally broad because the
 * session's workingDir (sandbox path like ~/.vellum/workspace) differs
 * from process.cwd() — using a directory-scoped rule would fail
 * matchesScope() and silently miss. Priority is set to 75 — above
 * default rules (50) so pre-approved tools aren't shadowed by default
 * `ask` rules (which would trigger prompting and auto-deny in
 * non-interactive task runs), but below user rules (100) so user deny
 * rules still take precedence. High-risk tool invocations still flow through
 * the normal risk-classification path rather than being blanket-approved.
 */
export function buildTaskRules(
  taskRunId: string,
  requiredTools: string[],
  _workingDir: string,
): TrustRule[] {
  return requiredTools.map((tool) => ({
    id: `ephemeral:${taskRunId}:${tool}`,
    tool,
    pattern: "**",
    // Only include scope for scoped tools — non-scoped tools don't carry scope.
    ...(SCOPED_TOOLS_SET.has(tool) ? { scope: "everywhere" } : {}),
    decision: "allow" as const,
    priority: 75,
    createdAt: Date.now(),
  }));
}
