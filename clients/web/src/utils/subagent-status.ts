/**
 * Pure status-display helpers for subagent entries.
 *
 * Shared by subagent-inline-progress-card, subagent-detail-panel, and subagent-status-badge.
 */

import type { SubagentStatus } from "@vellumai/assistant-api";

/** Whether the subagent is in an active (non-terminal) state. */
export function isActiveStatus(status: SubagentStatus): boolean {
  return (
    status === "running" || status === "pending" || status === "awaiting_input"
  );
}

/**
 * Whether an out-of-band status may overwrite the one the store already holds.
 *
 * Both out-of-band sources, the `subagents/reconcile` snapshot and history
 * notifications, are a round-trip old, so either can still report `running`
 * for a subagent whose terminal event has since landed over SSE. A settled
 * entry therefore only ever moves between terminal states: an interrupted run
 * emits nothing further, so a regression to an active status would stick the
 * overlay and the Stop control forever.
 */
export function shouldApplyStatus(
  existing: SubagentStatus,
  incoming: SubagentStatus,
): boolean {
  return isActiveStatus(existing) || !isActiveStatus(incoming);
}

/** Map a SubagentStatus to a semantic color token. */
export function statusColor(status: SubagentStatus): string {
  switch (status) {
    case "completed":
      return "var(--system-positive-strong)";
    case "failed":
    case "aborted":
    case "interrupted":
      return "var(--system-negative-strong)";
    default:
      return "var(--primary-base)";
  }
}

/** Human-readable label for the status badge. */
export function statusLabel(status: SubagentStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "awaiting_input":
      return "Awaiting Input";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "aborted":
      return "Aborted";
    case "interrupted":
      return "Interrupted";
    default:
      return "Unknown";
  }
}
