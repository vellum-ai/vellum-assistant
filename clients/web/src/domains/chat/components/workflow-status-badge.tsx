import type { WorkflowRunStatus } from "@vellumai/assistant-api";
import {
  statusColor,
  statusLabel,
} from "@/utils/workflow-status";
import { StatusBadgePill } from "@/domains/chat/components/status-badge-pill";
import type { WorkflowLeafStatus } from "@/domains/chat/workflow-store";

export function WorkflowStatusBadge({ status }: { status: WorkflowRunStatus }) {
  return (
    <StatusBadgePill color={statusColor(status)} label={statusLabel(status)} />
  );
}

// A leaf's status enum carries `cancelled` and omits the run-only terminals
// (aborted / cap_exceeded / interrupted), so it can't reuse the run-status
// helpers. Colors match the row's lead indicator.
function leafStatusColor(status: WorkflowLeafStatus): string {
  switch (status) {
    case "completed":
      return "var(--system-positive-strong)";
    case "failed":
      return "var(--system-negative-strong)";
    case "cancelled":
      return "var(--content-secondary)";
    default:
      return "var(--primary-base)";
  }
}

function leafStatusLabel(status: WorkflowLeafStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Running";
  }
}

/**
 * Status badge for a single workflow leaf (subagent), used in the drilled-in
 * leaf-detail header so the badge reflects the *selected leaf's* state rather
 * than its parent workflow's. Shares the same pill shell as
 * `WorkflowStatusBadge` so the two are identical in size and shape.
 */
export function WorkflowLeafStatusBadge({
  status,
}: {
  status: WorkflowLeafStatus;
}) {
  return (
    <StatusBadgePill
      color={leafStatusColor(status)}
      label={leafStatusLabel(status)}
    />
  );
}
