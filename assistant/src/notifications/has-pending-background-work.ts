import {
  allSubagentConversations,
  findConversation,
} from "../daemon/conversation-registry.js";
import {
  getSubagentRecordByConversationId,
  getSubagentRecordsByParent,
} from "../persistence/subagent-store.js";
import { hasPendingAgentWake } from "../runtime/agent-wake-queue.js";
import { TERMINAL_STATUSES } from "../subagent/types.js";
import { hasBackgroundToolWork } from "../tools/background-tool-registry.js";
import { isUserFacingSubagent } from "./completion-work.js";

/** A finished turn can still own delegated work whose result is not ready. */
export function hasPendingBackgroundWork(
  conversationId: string,
  options?: { startedAfter?: number },
): boolean {
  const conversation = findConversation(conversationId);
  // Terminal records can retain a live child while its queued follow-ups drain.
  for (const child of allSubagentConversations()) {
    if (
      child.parentConversationId !== conversationId ||
      (!child.isProcessing() && !child.hasQueuedMessages())
    ) {
      continue;
    }
    const task = getSubagentRecordByConversationId(child.conversationId);
    if (
      task &&
      isUserFacingSubagent(task) &&
      (options?.startedAfter === undefined ||
        task.createdAt >= options.startedAfter)
    ) {
      return true;
    }
  }
  return (
    conversation?.isProcessing() === true ||
    conversation?.hasQueuedMessages() === true ||
    // A newer human turn can finish inside the earlier wake's queue drain.
    (options?.startedAfter === undefined &&
      hasPendingAgentWake(conversationId)) ||
    getSubagentRecordsByParent(conversationId, {
      terminalStatuses: [...TERMINAL_STATUSES],
      maxTerminal: 0,
    }).some(
      (task) =>
        isUserFacingSubagent(task) &&
        (options?.startedAfter === undefined ||
          task.createdAt >= options.startedAfter),
    ) ||
    hasBackgroundToolWork(conversationId, options)
  );
}
