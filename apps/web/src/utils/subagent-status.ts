/**
 * Pure status-display helpers for subagent entries.
 *
 * Shared by subagent-inline-progress-card, subagent-detail-panel, and subagent-status-badge.
 */

import type { SubagentStatus } from "@vellumai/assistant-api";

/** Whether the subagent is in an active (non-terminal) state. */
export function isActiveStatus(status: SubagentStatus): boolean {
  return status === "running" || status === "pending" || status === "awaiting_input";
}

/** Map a SubagentStatus to a semantic color token. */
export function statusColor(status: SubagentStatus): string {
  switch (status) {
    case "completed":
      return "var(--system-positive-strong)";
    case "failed":
    case "aborted":
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
    default:
      return "Unknown";
  }
}
