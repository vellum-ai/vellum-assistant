/**
 * Pure status-display helpers for workflow runs.
 *
 * Shared by workflow-detail-panel and workflow-status-badge.
 */

import type { WorkflowRunStatus } from "@vellumai/assistant-api";

/** Whether the workflow run is in an active (non-terminal) state. */
export function isActiveStatus(status: WorkflowRunStatus): boolean {
  return status === "running";
}

/** Map a WorkflowRunStatus to a semantic color token. */
export function statusColor(status: WorkflowRunStatus): string {
  switch (status) {
    case "completed":
      return "var(--system-positive-strong)";
    case "failed":
    case "cap_exceeded":
      return "var(--system-negative-strong)";
    case "aborted":
    case "interrupted":
      return "var(--content-secondary)";
    default:
      return "var(--primary-base)";
  }
}

/** Human-readable label for the status badge. */
export function statusLabel(status: WorkflowRunStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "aborted":
      return "Aborted";
    case "cap_exceeded":
      return "Cap Exceeded";
    case "interrupted":
      return "Interrupted";
    default:
      return "Unknown";
  }
}
