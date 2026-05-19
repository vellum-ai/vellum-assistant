import type {
  ConfirmationRequestEvent,
  ContactRequestEvent,
  QuestionRequestEvent,
  SecretRequestEvent,
} from "@/domains/chat/lib/api.js";
import { normalizeQuestionRequest } from "@/domains/chat/lib/api.js";
import { attachConfirmationToToolCall } from "@/domains/chat/utils/chat-utils.js";
import type { PendingConfirmationState } from "@/domains/chat/types.js";
import { useInteractionStore } from "@/domains/interactions/interaction-store.js";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types.js";

export function handleSecretRequest(
  event: SecretRequestEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.dispatchTurn({ type: "SECRET_REQUEST" });
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
  ctx.dispatchTurn({ type: "CONFIRMATION_REQUEST" });
  const confData: PendingConfirmationState = {
    requestId: event.requestId,
    title: event.title,
    description: event.description,
    confirmLabel: event.confirmLabel,
    denyLabel: event.denyLabel,
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

  const result = attachConfirmationToToolCall(ctx.messagesRef.current, confData);
  ctx.setMessages(() => result.updatedMessages);

  if (result.attachedToolCallId) {
    useInteractionStore.getState().setInlineConfirmationToolCallId(result.attachedToolCallId);
    ctx.confirmationToolCallMapRef.current.set(
      confData.requestId,
      result.attachedToolCallId,
    );
  } else {
    useInteractionStore.getState().setInlineConfirmationToolCallId(null);
  }
}

export function handleContactRequest(
  event: ContactRequestEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.dispatchTurn({ type: "CONTACT_REQUEST" });
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
  ctx.dispatchTurn({ type: "QUESTION_REQUEST" });
  useInteractionStore.getState().showQuestion({
    requestId: event.requestId,
    entries,
    toolUseId: event.toolUseId,
  });
}
