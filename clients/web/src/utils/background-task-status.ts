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
    case "cancelled":
      return "var(--system-negative-strong)";
    default:
      return "var(--primary-base)";
  }
}

/**
 * Title for the detail panel and inline card headline, e.g. "Running command"
 * / "Command finished". Distinct from {@link backgroundTaskStatusLabel}, which
 * is the shorter status-badge copy ("Running" / "Completed").
 */
export function backgroundTaskTitle(status: BackgroundTaskStatus): string {
  switch (status) {
    case "running":
      return "Running command";
    case "completed":
      return "Command finished";
    case "cancelled":
      return "Command cancelled";
    case "failed":
      return "Command failed";
    default:
      return "Command";
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
