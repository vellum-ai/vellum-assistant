import type { WorkflowRunStatus } from "@vellumai/assistant-api";
import {
  statusColor,
  statusLabel,
} from "@/utils/workflow-status";
import { StatusBadgePill } from "@/domains/chat/components/status-badge-pill";

export function WorkflowStatusBadge({ status }: { status: WorkflowRunStatus }) {
  return (
    <StatusBadgePill color={statusColor(status)} label={statusLabel(status)} />
  );
}
