/**
 * Pure status-display helpers for background task entries.
 *
 * Shared by the viewer store and the background-task overlay.
 */

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Whether the task is in an active (non-terminal) state. */
export function isActiveBackgroundTaskStatus(
  status: BackgroundTaskStatus,
): boolean {
  return status === "running";
}

/** Map a BackgroundTaskStatus to a semantic color token. */
export function backgroundTaskStatusColor(status: BackgroundTaskStatus): string {
  switch (status) {
    case "completed":
      return "var(--system-positive-strong)";
    case "failed":
      return "var(--system-negative-strong)";
    case "cancelled":
      return "var(--text-muted)";
    default:
      return "var(--primary-base)";
  }
}

/** Human-readable label for the status badge. */
export function backgroundTaskStatusLabel(status: BackgroundTaskStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Unknown";
  }
}
