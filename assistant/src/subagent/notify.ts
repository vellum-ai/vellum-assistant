/**
 * Subagent → parent notification, decoupled from the SubagentManager.
 *
 * Routing (which parent a notification reaches) is taken from the live child
 * `Conversation`, which records its parent at spawn and is not writable by the
 * subagent's own sandbox tools. The durable subagent record supplies only the
 * cosmetic label/fork/objective metadata for the notification text. Keeping the
 * manager out of the import graph lets tool modules import these helpers without
 * pulling in the conversation/agent-loop core.
 *
 * Delivery targets the parent's in-process `Conversation` via the conversation
 * registry: a notification is injected only when the parent is live here.
 */

import {
  findConversation,
  findConversationOrSubagent,
} from "../daemon/conversation-registry.js";
import { getSubagentRecordByConversationId } from "../persistence/subagent-store.js";
import { getLogger } from "../util/logger.js";
import { type SubagentStatus, TERMINAL_STATUSES } from "./types.js";

const log = getLogger("subagent-notify");

/**
 * Enqueue (or persist + run) `message` as a user-role turn in the parent
 * conversation. No-op with a warning when the parent conversation is not live
 * in this process.
 *
 * Shared by the child-triggered {@link notifyParentFromChild} and the
 * manager's terminal/abort injections so every subagent → parent turn lands
 * through one path.
 */
export function injectMessageIntoParent(
  parentConversationId: string,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  const parentConversation = findConversation(parentConversationId);
  if (!parentConversation) {
    log.warn(
      { parentConversationId },
      "Subagent notification target parent conversation not found",
    );
    return;
  }
  const enqueueResult = parentConversation.enqueueMessage({
    content: message,
    metadata,
  });
  if (!enqueueResult.queued && !enqueueResult.rejected) {
    parentConversation
      .persistUserMessage({ content: message, metadata })
      .then(({ id: messageId }) =>
        parentConversation.runAgentLoop(message, messageId),
      )
      .catch((err) => {
        log.error(
          { parentConversationId, err },
          "Failed to process subagent notification in parent",
        );
      });
  }
}

/**
 * Deliver a mid-run notification from a subagent to its parent conversation.
 *
 * The parent is resolved from the live child conversation's `parentConversationId`
 * (set at spawn, not writable by the subagent), so a subagent cannot redirect
 * the notification to another conversation by tampering with its durable record.
 *
 * Returns `false` when `childConversationId` is not a live subagent, or when the
 * subagent has already reached a terminal status (the parent receives the
 * terminal summary through a separate path); `true` when the notification was
 * injected into the parent.
 */
export function notifyParentFromChild(
  childConversationId: string,
  message: string,
  urgency: string,
): boolean {
  const child = findConversationOrSubagent(childConversationId);
  if (!child?.isSubagent || !child.parentConversationId) {
    return false;
  }
  const parentConversationId = child.parentConversationId;

  // Cosmetic metadata only — a tampered record can at most mislabel a
  // notification to the child's own (routing is fixed to the live parent above).
  const record = getSubagentRecordByConversationId(childConversationId);
  if (record && TERMINAL_STATUSES.has(record.status as SubagentStatus)) {
    return false;
  }
  const label = record?.label ?? "subagent";
  const isFork = record?.isFork ?? false;

  const prefix = isFork ? "Fork" : "Subagent";
  let notificationString = `[${prefix} "${label}" — ${urgency}] ${message}`;
  if (urgency === "blocked") {
    notificationString += `\nUse subagent_message to send guidance to this ${prefix.toLowerCase()}.`;
  }

  injectMessageIntoParent(parentConversationId, notificationString, {
    subagentNotification: {
      subagentId: record?.id ?? childConversationId,
      label,
      status: "running" as const,
      conversationId: childConversationId,
      objective: record?.objective ?? "",
    },
  });
  return true;
}
