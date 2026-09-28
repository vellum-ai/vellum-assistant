import { isAssistantInitiatedThreadsEnabled } from "../config/assistant-initiated-threads-gate.js";
import { getConversation } from "../persistence/conversation-crud.js";
import { ASSISTANT_INITIATED_SOURCE } from "../persistence/conversation-types.js";
import type { NotificationSignal } from "./signal.js";

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

  const producing = getConversation(signal.sourceContextId);
  if (
    producing &&
    producing.conversationType !== "background" &&
    producing.conversationType !== "scheduled"
  ) {
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
