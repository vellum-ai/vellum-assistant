/**
 * Who owns what while a prompt submission is in flight.
 *
 * A prompt (confirmation, question, secret, contact request) and the request
 * answering it have separate lifetimes. The card can be retired, replaced, or
 * abandoned while its answer is still on the wire, and the daemon makes that
 * ordinary rather than rare: it broadcasts `interaction_resolved` before its
 * POST response returns, so a submission's own resolution routinely retires its
 * card mid-flight.
 *
 * Two questions follow from that, and they have different answers, which is why
 * they are asked separately here rather than inferred from the store at each
 * call site.
 */

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";

/** The prompt kinds that can have a submission in flight. */
export type PromptKind =
  | "confirmation"
  | "question"
  | "secret"
  | "contactRequest";

/** The prompt currently on screen for `kind`, if any. */
function promptOnScreen(kind: PromptKind): { requestId: string } | null {
  const state = useInteractionStore.getState();
  switch (kind) {
    case "confirmation":
      return state.pendingConfirmation;
    case "question":
      return state.pendingQuestion;
    case "secret":
      return state.pendingSecret;
    case "contactRequest":
      return state.pendingContactRequest;
  }
}

/**
 * Whether `requestId` still holds `kind`'s submission slot.
 *
 * The slot is claimed by the submission that starts it and released by that
 * same submission, so this is a comparison against a value the asker itself
 * wrote. Nothing about the prompt's own lifecycle touches it.
 */
export function stillOwnsSubmission(
  kind: PromptKind,
  requestId: string,
): boolean {
  return useInteractionStore.getState().submittingByKind[kind] === requestId;
}

/**
 * Put a submission failure in front of the user, if it is still theirs to
 * report.
 *
 * Stricter than {@link stillOwnsSubmission}, and both halves earn their place.
 * The request must still hold the slot, which rules out a submission a reset
 * abandoned: the user sent something else and moved on, so an error about the
 * interaction they walked away from is noise. And no other prompt may be on
 * screen, because the session error has no prompt of its own and reads as
 * belonging to whatever card is up, so a replaced request would be explaining
 * itself over someone else's question.
 *
 * No prompt at all is fine as long as the slot is still held: that is a request
 * whose own resolution retired its card while it was awaiting, and nothing is
 * left for the message to be mistaken for.
 *
 * Releasing the slot is deliberately not routed through here. It belongs to the
 * request whatever else has happened.
 */
export function reportSubmissionFailure(
  kind: PromptKind,
  requestId: string,
  message: string,
): void {
  if (!stillOwnsSubmission(kind, requestId)) {
    return;
  }
  const onScreen = promptOnScreen(kind);
  if (onScreen && onScreen.requestId !== requestId) {
    return;
  }
  useChatSessionStore.getState().setError({ message });
}
