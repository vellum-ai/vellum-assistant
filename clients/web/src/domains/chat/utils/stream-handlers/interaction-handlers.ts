import { attachConfirmationToToolCall } from "@/domains/chat/utils/chat";
import type { PendingConfirmationState } from "@/domains/chat/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  ConfirmationRequestEvent,
  ContactRequestEvent,
  InteractionResolvedEvent,
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
    service: event.service,
    field: event.field,
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

  // The reducer folds the inline confirmation marker onto the tool-call row in
  // the snapshot. Here we only need the matched tool-call id for the
  // interaction store, so compute it read-only against the current snapshot
  // (the tool call is already present from the `tool_use_start` fold).
  const { attachedToolCallId } = attachConfirmationToToolCall(
    useChatSessionStore.getState().snapshot?.messages ?? [],
    confData,
  );

  if (attachedToolCallId) {
    useInteractionStore
      .getState()
      .setInlineConfirmationToolCallId(attachedToolCallId);
    ctx.setConfirmationToolCall(confData.requestId, attachedToolCallId);
  } else {
    useInteractionStore.getState().setInlineConfirmationToolCallId(null);
  }
}

/**
 * Retire an active confirmation prompt when the daemon reports its pending
 * interaction has resolved (approved, rejected, cancelled, or superseded).
 *
 * `interaction_resolved` is conversation-scoped, so by the time it reaches a
 * chat stream handler it is guaranteed to be for the active conversation.
 * Attention tracking (`use-attention-tracking`) deliberately skips the active
 * conversation and defers its confirmation card to this handler — so without
 * it, a confirmation the daemon has already discarded (e.g. an `acp_spawn`
 * that timed out) would linger on screen with no way to act on it, and tapping
 * Allow/Deny would 404.
 *
 * Only confirmation kinds render a card here; other kinds (host-proxy steps,
 * secrets, questions) own their own lifecycle. The requestId guards make a
 * mismatched or already-cleared confirmation a no-op.
 */
export function handleInteractionResolved(
  event: InteractionResolvedEvent,
): void {
  if (event.kind !== "confirmation" && event.kind !== "acp_confirmation") {
    return;
  }
  const { requestId } = event;
  const session = useChatSessionStore.getState();
  const interaction = useInteractionStore.getState();

  interaction.dismissConfirmationIfMatches(requestId);

  const mappedToolCallId = session.confirmationToolCallMap.get(requestId);
  if (
    mappedToolCallId &&
    interaction.inlineConfirmationToolCallId === mappedToolCallId
  ) {
    interaction.setInlineConfirmationToolCallId(null);
  }

  // The reducer folds the marker-clear onto the snapshot tool call; here we
  // only release the interaction-store bookkeeping.
  session.deleteConfirmationToolCall(requestId);
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
