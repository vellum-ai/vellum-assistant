import { attachConfirmationToToolCall } from "@/domains/chat/utils/chat";
import type { PendingConfirmationState } from "@/domains/chat/types";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  ConfirmationRequestEvent,
  ContactRequestEvent,
  QuestionRequestEvent,
  SecretRequestEvent,
} from "@vellumai/assistant-api";
import { normalizeQuestionRequest } from "@/domains/chat/api/event-types";

export function handleSecretRequest(
  event: SecretRequestEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.onSecretRequest();
  useInteractionStore.getState().showSecret({
    requestId: event.requestId,
    label: event.label,
    description: event.description,
    placeholder: event.placeholder,
    allowOneTimeSend: event.allowOneTimeSend,
    allowedTools: event.allowedTools,
    allowedDomains: event.allowedDomains,
    purpose: event.purpose,
  });
}

export function handleConfirmationRequest(
  event: ConfirmationRequestEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.onConfirmationRequest();
  const confData: PendingConfirmationState = {
    requestId: event.requestId,
    toolName: event.toolName,
    riskLevel: event.riskLevel,
    riskReason: event.riskReason,
    allowlistOptions: event.allowlistOptions,
    scopeOptions: event.scopeOptions,
    directoryScopeOptions: event.directoryScopeOptions,
    persistentDecisionsAllowed: event.persistentDecisionsAllowed,
    input: event.input,
    toolUseId: event.toolUseId,
  };
  useInteractionStore.getState().showConfirmation(confData);

  const result = attachConfirmationToToolCall(
    ctx.messages,
    confData,
  );
  ctx.setMessages(() => result.updatedMessages);

  if (result.attachedToolCallId) {
    useInteractionStore
      .getState()
      .setInlineConfirmationToolCallId(result.attachedToolCallId);
    ctx.setConfirmationToolCall(confData.requestId, result.attachedToolCallId);
  } else {
    useInteractionStore.getState().setInlineConfirmationToolCallId(null);
  }
}

export function handleContactRequest(
  event: ContactRequestEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.onContactRequest();
  useInteractionStore.getState().showContactRequest({
    requestId: event.requestId,
    channel: event.channel,
    placeholder: event.placeholder,
    label: event.label,
    description: event.description,
    role: event.role,
  });
}

export function handleQuestionRequest(
  event: QuestionRequestEvent,
  ctx: StreamHandlerContext,
): void {
  const entries = normalizeQuestionRequest(event);
  if (entries.length === 0) return;
  ctx.turnActions.onQuestionRequest();
  useInteractionStore.getState().showQuestion({
    requestId: event.requestId,
    entries,
    toolUseId: event.toolUseId,
  });
}
