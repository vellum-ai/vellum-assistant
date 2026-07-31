/**
 * Pure status-display helpers for ACP run entries.
 *
 * Shared by the acp-run inline card, detail panel, and status badge.
 */

export type AcpRunStatus =
  "initializing" | "running" | "completed" | "failed" | "cancelled";

/** Whether the run is in an active (non-terminal) state. */
export function isActiveAcpStatus(status: AcpRunStatus): boolean {
  return status === "initializing" || status === "running";
}

/** Map an AcpRunStatus to a semantic color token. */
export function acpRunStatusColor(status: AcpRunStatus): string {
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

/** Human-readable label for the status badge. */
export function acpRunStatusLabel(status: AcpRunStatus): string {
  switch (status) {
    case "initializing":
      return "Initializing";
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

/**
 * Badge label + color, accounting for the stop reason. A run cancelled
 * mid-flight lands as `completed` + `stopReason: "cancelled"` (partial work),
 * which the plain status helpers would mislabel as a green "Completed". Surface
 * it as an amber "Cancelled" instead — matching the inline card's `warning`
 * state and the terminal system block's copy.
 */
export function acpRunStatusBadge(
  status: AcpRunStatus,
  stopReason: string | undefined,
): { label: string; color: string } {
  if (status === "completed" && stopReason === "cancelled") {
    return { label: "Cancelled", color: "var(--system-mid-strong)" };
  }
  return { label: acpRunStatusLabel(status), color: acpRunStatusColor(status) };
}
