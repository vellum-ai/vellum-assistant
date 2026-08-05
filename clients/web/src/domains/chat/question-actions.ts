/**
 * Question-response interaction handlers.
 *
 * Stateless imperative functions — no React hooks, no component state.
 * Each reads store state via `.getState()` and coordinates the
 * submit/dismiss lifecycle for multi-field question prompts.
 */

import { captureError } from "@/lib/sentry/capture-error";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { submitQuestionResponse } from "@/domains/chat/api/interactions";
import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";

/**
 * Whether `requestId` still owns the shared question state.
 *
 * `isSubmittingQuestion` and the session error are single slots on the store,
 * not per-request. Only one in-flight submission may write them, and that is
 * whichever request the currently pending prompt belongs to. A request whose
 * prompt has since been replaced must leave both alone.
 *
 * This handoff is the norm rather than a rare race. The daemon supersedes an
 * open prompt with a newer one, and `showQuestion` clears
 * `isSubmittingQuestion` when the newer prompt arrives, so the user can answer
 * it while the older request is still in flight. Every completion path of the
 * older request then lands after ownership has already moved.
 *
 * A null pending prompt reads as still-owned: the card is simply gone (retired
 * by `interaction_resolved`, or by this request's own success), and the
 * leftover submitting/error state is this request's to clean up.
 */
function stillOwnsQuestionState(requestId: string): boolean {
  const { pendingQuestion } = useInteractionStore.getState();
  return !pendingQuestion || pendingQuestion.requestId === requestId;
}

/**
 * Clear a question prompt the daemon has already discarded.
 *
 * A question POST comes back 404 ("No pending question interaction found for
 * this requestId") when the server-side pending interaction is gone: the prompt
 * timed out, the turn was aborted, a newer user message superseded it, or a
 * daemon restart dropped it. This is terminal and non-retryable, because the
 * answer is moot once the server has moved on. The matching
 * `interaction_resolved` event that would normally retire the card can be
 * missed entirely (the web / iOS SSE stream tears down on app background and
 * has no replay), so the stale prompt lingers, leaving the user tapping options
 * into the same 404.
 *
 * Retire the prompt without surfacing a blocking error so the user is never
 * stranded. Mirrors `clearStaleConfirmation` in `confirmation-actions.ts`,
 * minus its attention-key release: an attention key is only ever recorded for a
 * pending secret or confirmation, never a question.
 *
 * Bails entirely when a newer prompt has taken over: clearing there would
 * reopen the double-submit guard and erase a real failure the user needs to
 * see. See {@link stillOwnsQuestionState}.
 */
function clearStaleQuestion(requestId: string): void {
  if (!stillOwnsQuestionState(requestId)) {
    return;
  }
  useInteractionStore.getState().dismissQuestionIfMatches(requestId);
  useInteractionStore.getState().submitQuestionEnd();
  useChatSessionStore.getState().setError(null);
}

/**
 * Submit the user's answers to a pending question prompt.
 *
 * A new SSE-driven `question_request` can arrive mid-flight and take over the
 * shared submitting/error state, so every path that resumes after the POST
 * checks {@link stillOwnsQuestionState} before writing to it. Everything before
 * the POST runs synchronously, so ownership cannot change there.
 */
export async function handleQuestionResponse(
  responses: QuestionResponseEntry[],
): Promise<void> {
  const { pendingQuestion: snapshot, isSubmittingQuestion } =
    useInteractionStore.getState();
  if (!snapshot || isSubmittingQuestion) {
    return;
  }
  useInteractionStore.getState().submitQuestionStart();
  useChatSessionStore.getState().setError(null);

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    // No ownership check: this runs in the same synchronous block as the entry
    // guard above, so no newer prompt can have arrived yet.
    useChatSessionStore
      .getState()
      .setError({ message: "No active session. Please try again." });
    useInteractionStore.getState().submitQuestionEnd();
    return;
  }

  try {
    const result = await submitQuestionResponse(
      ctx.assistantId,
      snapshot.requestId,
      { kind: "submit", responses },
    );
    if (!result.ok) {
      if (result.status === 404) {
        clearStaleQuestion(snapshot.requestId);
        return;
      }
      // A retryable failure, so the card stays and the user is told. Both
      // writes belong to whoever owns the state now.
      if (stillOwnsQuestionState(snapshot.requestId)) {
        useChatSessionStore.getState().setError({ message: result.error });
        useInteractionStore.getState().submitQuestionEnd();
      }
      return;
    }
    // Success. Retire the card this answer belongs to; if it is already gone,
    // release the submitting flag. When a newer prompt holds it instead, leave
    // it running: releasing here would reopen the double-submit guard while
    // that prompt's own request is still in flight.
    const { pendingQuestion } = useInteractionStore.getState();
    if (pendingQuestion?.requestId === snapshot.requestId) {
      useInteractionStore.getState().dismissQuestion();
    } else if (!pendingQuestion) {
      useInteractionStore.getState().submitQuestionEnd();
    }
  } catch (err) {
    // Transport failure (network drop, abort, malformed response). Always
    // report it, but only surface it to the user when this request still owns
    // the banner, so a dead request cannot mask a live one's failure.
    captureError(err, { context: "submit_question_response" });
    if (stillOwnsQuestionState(snapshot.requestId)) {
      useChatSessionStore
        .getState()
        .setError({ message: "Failed to submit response. Please try again." });
      useInteractionStore.getState().submitQuestionEnd();
    }
  }
}

/**
 * Dismiss (close) the pending question prompt without submitting answers.
 * Sends a "close" signal to the daemon so the turn can proceed.
 */
export function handleDismissPendingQuestion(): void {
  const snapshot = useInteractionStore.getState().pendingQuestion;
  useInteractionStore.getState().dismissQuestion();
  if (!snapshot) {
    return;
  }
  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    return;
  }
  submitQuestionResponse(ctx.assistantId, snapshot.requestId, {
    kind: "close",
  })
    .then((result) => {
      // A 404 on close is the expected outcome, not a failure: the card is
      // being dismissed precisely because the user is done with it, and the
      // daemon may already have settled the prompt itself (timeout, abort,
      // supersession). Reporting it produced steady Sentry noise with no
      // actionable signal. Every other status still reports.
      if (!result.ok && result.status !== 404) {
        captureError(
          new Error(`question-response close failed: ${result.error}`),
          {
            context: "submit_question_response_close",
            extra: { status: result.status },
          },
        );
      }
    })
    .catch((err) => {
      captureError(err, { context: "submit_question_response_close" });
    });
}
