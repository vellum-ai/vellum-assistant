import type { TurnWorkOrigin } from "../daemon/conversation-queue-manager.js";
import {
  getSubagentRecordById,
  type SubagentRecord,
} from "../persistence/subagent-store.js";

/** Match the parent delivery contract: advisors and silent forks stay internal. */
export function isUserFacingSubagent(
  task: Pick<SubagentRecord, "role" | "isFork" | "sendResultToUser">,
): boolean {
  return (
    task.role !== "advisor" &&
    (task.isFork
      ? task.sendResultToUser === true
      : task.sendResultToUser !== false)
  );
}

export function workStartedAfter(
  message: TurnWorkOrigin,
  cutoff: number,
): boolean {
  const taskNotification = message.metadata?.subagentNotification;
  if (
    taskNotification &&
    typeof taskNotification === "object" &&
    "subagentId" in taskNotification &&
    typeof taskNotification.subagentId === "string"
  ) {
    const task = getSubagentRecordById(taskNotification.subagentId);
    if (task) {
      return isUserFacingSubagent(task) && task.createdAt >= cutoff;
    }
  }
  const command = message.metadata?.backgroundToolCompletion;
  if (
    message.metadata?.backgroundEventSource === "background-tool" &&
    command &&
    typeof command === "object" &&
    "startedAt" in command &&
    typeof command.startedAt === "number"
  ) {
    return command.startedAt >= cutoff;
  }
  return message.sentAt >= cutoff;
}
