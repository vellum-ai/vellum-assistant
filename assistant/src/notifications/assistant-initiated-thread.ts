import { isAssistantInitiatedThreadsEnabled } from "../config/assistant-initiated-threads-gate.js";
import {
  getConversation,
  getDisplayMetaForConversations,
  getMessageById,
} from "../persistence/conversation-crud.js";
import {
  ASSISTANT_INITIATED_SOURCE,
  UNGROUPED_GROUP_ID,
} from "../persistence/conversation-types.js";
import { getLogger } from "../util/logger.js";
import type { NotificationSignal } from "./signal.js";

const log = getLogger("assistant-initiated-thread");

export interface AssistantInitiatedThreadResolution {
  /** Eligible for automatic promotion; creation and sidebar membership are not guaranteed. */
  isCandidate: boolean;
  /** Prepared for vellum pairing only. Other channels retain the producer's signal. */
  vellumSignal: NotificationSignal;
}

/** Background shares need a visible thread because their producer is hidden from the sidebar. */
export function resolveAssistantInitiatedThread(
  signal: NotificationSignal,
): AssistantInitiatedThreadResolution {
  if (
    signal.sourceEventName !== "assistant.share" ||
    signal.requiresConversation === true ||
    signal.conversationMetadata?.source !== undefined ||
    !isAssistantInitiatedThreadsEnabled()
  ) {
    return { isCandidate: false, vellumSignal: signal };
  }

  try {
    const producing = getConversation(signal.sourceContextId);
    if (
      producing &&
      producing.conversationType !== "background" &&
      producing.conversationType !== "scheduled"
    ) {
      return { isCandidate: false, vellumSignal: signal };
    }
  } catch (err) {
    log.warn(
      { err, sourceContextId: signal.sourceContextId },
      "Unable to resolve the assistant-initiated thread candidate",
    );
    return { isCandidate: false, vellumSignal: signal };
  }

  return {
    isCandidate: true,
    vellumSignal: {
      ...signal,
      requiresConversation: true,
      conversationMetadata: {
        ...signal.conversationMetadata,
        source: ASSISTANT_INITIATED_SOURCE,
      },
    },
  };
}

/** A new thread can alert only after its visible destination and seed are durable. */
export function isPersistedAssistantInitiatedThread(
  conversationId: string | null,
  messageId: string | null,
): boolean {
  if (!conversationId || !messageId) {
    return false;
  }
  try {
    const conversation = getConversation(conversationId);
    if (
      !conversation ||
      conversation.source !== ASSISTANT_INITIATED_SOURCE ||
      conversation.conversationType !== "standard" ||
      conversation.archivedAt !== null
    ) {
      return false;
    }
    const placement = getDisplayMetaForConversations([conversationId]).get(
      conversationId,
    );
    return (
      placement !== undefined &&
      !placement.isPinned &&
      (placement.groupId === null ||
        placement.groupId === UNGROUPED_GROUP_ID) &&
      getMessageById(messageId, conversationId) !== null
    );
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Unable to verify the notification thread and seed",
    );
    return false;
  }
}
