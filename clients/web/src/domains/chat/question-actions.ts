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
 * Bails entirely when a newer prompt has taken over. `isSubmittingQuestion` and
 * the session error are shared, not per-request, so a late 404 must not touch
 * them once they belong to someone else. That handoff is the norm rather than a
 * rare race: the daemon supersedes this prompt with the newer one, which is
 * *why* this request 404s, and `showQuestion` clears `isSubmittingQuestion` on
 * arrival, so the newer prompt can already be in flight by the time the older
 * response lands. Clearing it there would reopen the double-submit guard and
 * erase a real failure the user needs to see.
 */
function clearStaleQuestion(requestId: string): void {
  const { pendingQuestion } = useInteractionStore.getState();
  if (pendingQuestion && pendingQuestion.requestId !== requestId) {
    return;
  }
  useInteractionStore.getState().dismissQuestionIfMatches(requestId);
  useInteractionStore.getState().submitQuestionEnd();
  useChatSessionStore.getState().setError(null);
}

/**
 * Submit the user's answers to a pending question prompt.
 * Guards against a new SSE-driven `question_request` arriving mid-flight
 * by comparing request IDs before clearing state.
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
      useChatSessionStore.getState().setError({ message: result.error });
      useInteractionStore.getState().submitQuestionEnd();
      return;
    }
    if (
      useInteractionStore.getState().pendingQuestion?.requestId ===
      snapshot.requestId
    ) {
      useInteractionStore.getState().dismissQuestion();
    } else {
      useInteractionStore.getState().submitQuestionEnd();
    }
  } catch (err) {
    captureError(err, { context: "submit_question_response" });
    useChatSessionStore
      .getState()
      .setError({ message: "Failed to submit response. Please try again." });
    useInteractionStore.getState().submitQuestionEnd();
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
