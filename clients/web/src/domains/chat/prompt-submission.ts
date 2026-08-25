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
 *
 * The same identity drives the double-submit guard every submit path opens
 * with: it compares the slot against *this* prompt's request, not against
 * "anything in flight". A newer prompt supersedes an older one while that
 * older answer is still on the wire, and the user has to be able to answer
 * what is now in front of them. Starting that submission is what moves
 * ownership; the older one stands down when it returns.
 */

import { type ParseKeys, t } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import type { SubmitSecretResponseResult } from "@/domains/chat/api/interactions";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";

/**
 * The prompt kinds that can have a submission in flight.
 *
 * Deliberately not `UserFacingInteractionKind`, which it overlaps on three
 * members. That union mirrors the daemon's registry enum; this one names the
 * cards the client can be mid-submit on. `contactRequest` is client-only and
 * has no daemon interaction at all, and `acp_confirmation` shares the
 * confirmation card and so shares its slot rather than owning one. Merging
 * them would give two of these four the wrong answer.
 */
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
 *
 * The message is a catalog key rather than a string, so what reaches the banner
 * is copy written for this surface in the reader's language. An assistant's own
 * rejection text describes a request the client built and cannot be passed
 * here: it belongs in Sentry, where it names the mismatch.
 */
export function reportSubmissionFailure(
  kind: PromptKind,
  requestId: string,
  messageKey: ParseKeys<"chat">,
): void {
  if (!ownsTheBanner(kind, requestId)) {
    return;
  }
  useChatSessionStore
    .getState()
    .setError({ message: t(messageKey, { ns: "chat" }) });
}

/**
 * Record the assistant's rejection of a submission, which is a diagnostic
 * rather than something to show: it describes a request the client built.
 *
 * A transport failure is not recorded at all. Being offline is not an
 * application defect, and `transient` is what survives of the `TypeError`
 * that `captureError`'s own filter keys on, since the API helpers catch it
 * and flatten it into an ordinary failure.
 */
export function captureSubmissionRejection(
  context: string,
  result: Extract<SubmitSecretResponseResult, { ok: false }>,
): void {
  if (result.transient) {
    return;
  }
  captureError(new Error(`${context}: ${result.error}`), {
    context,
    extra: { status: result.status },
  });
}

/**
 * Take a submission failure back down.
 *
 * Same door as {@link reportSubmissionFailure} and for the same reason: a
 * request that may not write the banner may not wipe it either, or a resolution
 * arriving for an abandoned request would clear a message that belongs to
 * whatever the user is looking at now.
 */
export function clearSubmissionFailure(
  kind: PromptKind,
  requestId: string,
): void {
  if (!ownsTheBanner(kind, requestId)) {
    return;
  }
  useChatSessionStore.getState().setError(null);
}

function ownsTheBanner(kind: PromptKind, requestId: string): boolean {
  if (!stillOwnsSubmission(kind, requestId)) {
    return false;
  }
  const onScreen = promptOnScreen(kind);
  return !onScreen || onScreen.requestId === requestId;
}
