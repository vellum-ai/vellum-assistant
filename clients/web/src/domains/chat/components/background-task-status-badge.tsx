import {
  backgroundTaskStatusColor,
  backgroundTaskStatusLabel,
  type BackgroundTaskStatus,
} from "@/utils/background-task-status";
import { StatusBadgePill } from "@/domains/chat/components/status-badge-pill";

export function BackgroundTaskStatusBadge({
  status,
}: {
  status: BackgroundTaskStatus;
}) {
  return (
    <StatusBadgePill
      color={backgroundTaskStatusColor(status)}
      label={backgroundTaskStatusLabel(status)}
    />
  );
}
