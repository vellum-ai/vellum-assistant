import { attachConfirmationToToolCall } from "@/domains/chat/utils/chat";
import type { PendingConfirmationState } from "@/domains/chat/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  ConfirmationRequestEvent,
  ContactFormClosedEvent,
  ContactRecordRequestEvent,
  ContactRequestEvent,
  InteractionResolvedEvent,
  QuestionRequestEvent,
  SecretRequestEvent,
} from "@vellumai/assistant-api";
import { normalizeQuestionRequest } from "@/domains/chat/api/event-types";
import { ensureMainWindowVisible } from "@/runtime/main-window";

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

  // **And the window comes forward.** A confirmation is the one thing the
  // assistant cannot get past on its own, and the card that answers it is drawn
  // in the app's window. A turn started from the companion, or by a schedule,
  // or from anywhere else while the user is working in another app, leaves that
  // window behind whatever is in front of it, so the run stops on a question
  // nobody can see and the assistant reads as having gone quiet.
  //
  // Off Electron this is a no-op (`main-window` wraps a host capability the web
  // and iOS builds do not have), and a window already frontmost is raised to
  // where it already is. Fire and forget: nothing below waits on it.
  //
  // The better end state is answering the request on the companion itself,
  // which is not this: the surface holds no interaction store and no way to
  // send a decision, only the words of a message and the tail of a reply.
  void ensureMainWindowVisible();

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
 * Retire an active confirmation or question prompt when the daemon reports its
 * pending interaction has resolved (approved, rejected, answered, cancelled, or
 * superseded).
 *
 * `interaction_resolved` is conversation-scoped, so by the time it reaches a
 * chat stream handler it is guaranteed to be for the active conversation.
 * Attention tracking (`use-attention-tracking`) deliberately skips the active
 * conversation and defers its card to this handler. Without it, a prompt the
 * daemon has already discarded (e.g. an `acp_spawn` that timed out) would
 * linger on screen with no way to act on it, and acting on it would 404.
 *
 * Both card-rendering kinds are handled here. A question card is retired by
 * `question-actions` on the two outcomes the user drives (a submitted answer,
 * the X), but every other settlement is invisible to the client: the prompt
 * timed out, the turn aborted, a newer message superseded it, or the daemon
 * restarted. Those all funnel through the prompter's `finish()`, which
 * deregisters the interaction and broadcasts this event, making it the only
 * signal the card has become undecidable. Host-proxy steps and secrets render
 * no card here. The requestId guards make a mismatched or already-cleared
 * prompt a no-op.
 */
export function handleInteractionResolved(
  event: InteractionResolvedEvent,
): void {
  const { requestId } = event;

  if (event.kind === "question") {
    useInteractionStore.getState().dismissQuestionIfMatches(requestId);
    return;
  }

  if (event.kind !== "confirmation" && event.kind !== "acp_confirmation") {
    return;
  }
  const session = useChatSessionStore.getState();
  const interaction = useInteractionStore.getState();

  interaction.dismissConfirmationIfMatches(requestId);

  interaction.releaseInlineAnchorIfMatches(
    session.confirmationToolCallMap.get(requestId),
  );

  // The reducer folds the marker-clear onto the snapshot tool call; here we
  // only release the interaction-store bookkeeping.
  session.deleteConfirmationToolCall(requestId);
}

/**
 * Raise an address form.
 *
 * The turn is left alone. This event carries no conversation, so the only one
 * available is whichever the guardian happens to be viewing, which for a form
 * raised by a background command is a conversation that is not waiting on
 * anything: parking it would show an unrelated turn as awaiting input, and
 * make it look like this form's to end.
 */
export function handleContactRequest(
  event: ContactRequestEvent,
  _ctx: StreamHandlerContext,
): void {
  useInteractionStore.getState().showContactRequest({
    requestId: event.requestId,
    channel: event.channel,
    placeholder: event.placeholder,
    defaultValue: event.defaultValue,
    label: event.label,
    description: event.description,
    role: event.role,
    verify: event.verify,
  });
}

/**
 * Raise a record form. The turn is left alone, for the same reason the address
 * form leaves it alone.
 */
export function handleContactRecordRequest(
  event: ContactRecordRequestEvent,
  _ctx: StreamHandlerContext,
): void {
  useInteractionStore.getState().showContactRecordRequest({
    requestId: event.requestId,
    operation: event.operation,
    contactId: event.contactId,
    currentDisplayName: event.currentDisplayName,
    currentNotes: event.currentNotes,
    channels: event.channels,
    displayName: event.displayName,
    notes: event.notes,
    notesProposed: event.notesProposed,
    label: event.label,
    description: event.description,
  });
}

/**
 * How long a card stays up after its form closes, so a submission still on the
 * wire has time to say whether this client is the one that answered.
 */
const ANSWERED_CARD_LINGER_MS = 3000;

/**
 * Retire whichever contact form has closed. A closed form accepts no
 * submission, so a card left up offers an answer the gateway would refuse.
 *
 * A card with a submission still on the wire is given a moment rather than
 * retired at once: the gateway resolves the form, and so broadcasts this,
 * before its own HTTP response returns, so this can arrive first and cutting
 * the card would lose the confirmation the guardian is waiting to see.
 *
 * It is not taken as proof that this client is the one that answered. The
 * broadcast names the form, not the submission, so every client submitting it
 * concurrently matches, including the ones whose claim lost. Only that
 * client's own response can say it wrote anything, so the confirmation is left
 * for it to set; if it never arrives, the card retires unconfirmed rather than
 * claiming a save that may belong to somebody else.
 *
 * A form that closed any other way is retired everywhere, including on the
 * client whose write failed: its card has nothing left to submit to.
 */
export function handleContactFormClosed(event: ContactFormClosedEvent): void {
  const store = useInteractionStore.getState();

  const ownsAddressForm =
    store.pendingContactRequest?.requestId === event.requestId &&
    (store.contactRequestAccepted ||
      store.submittingByKind.contactRequest === event.requestId);
  const ownsRecordForm =
    store.pendingContactRecordRequest?.requestId === event.requestId &&
    (store.contactRecordRequestAccepted ||
      store.submittingByKind.contactRecordRequest === event.requestId);

  if (event.reason === "answered" && (ownsAddressForm || ownsRecordForm)) {
    setTimeout(() => {
      const latest = useInteractionStore.getState();
      latest.dismissContactRequestIfMatches(event.requestId);
      latest.dismissContactRecordRequestIfMatches(event.requestId);
    }, ANSWERED_CARD_LINGER_MS);
    return;
  }

  store.dismissContactRequestIfMatches(event.requestId);
  store.dismissContactRecordRequestIfMatches(event.requestId);
}

export function handleQuestionRequest(
  event: QuestionRequestEvent,
  ctx: StreamHandlerContext,
): void {
  const entries = normalizeQuestionRequest(event);
  if (entries.length === 0) {
    return;
  }
  ctx.turnActions.onQuestionRequest();
  useInteractionStore.getState().showQuestion({
    requestId: event.requestId,
    entries,
    toolUseId: event.toolUseId,
  });
}
