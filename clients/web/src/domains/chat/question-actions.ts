/**
 * Question-response interaction handlers.
 *
 * Stateless imperative functions — no React hooks, no component state.
 * Each reads store state via `.getState()` and coordinates the
 * submit/dismiss lifecycle for multi-field question prompts.
 */

import { t } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import {
  clearSubmissionFailure,
  captureSubmissionRejection,
  reportSubmissionFailure,
  stillOwnsSubmission,
} from "@/domains/chat/prompt-submission";
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
 * Bails entirely when a newer prompt has taken over: clearing there would
 * reopen the double-submit guard and erase a real failure the user needs to
 * see. See {@link stillOwnsSubmission}.
 */
function clearStaleQuestion(requestId: string): void {
  if (!stillOwnsSubmission("question", requestId)) {
    return;
  }
  useInteractionStore.getState().dismissQuestionIfMatches(requestId);
  // Before the release, which is what the clear's own door reads. Retiring
  // this prompt first is what lets the door open when nothing replaced it.
  clearSubmissionFailure("question", requestId);
  useInteractionStore.getState().releaseSubmission("question", requestId);
}

/**
 * Submit the user's answers to a pending question prompt.
 *
 * A new SSE-driven `question_request` can arrive mid-flight and be answered
 * while this one is still on the wire, so every path that resumes after the
 * POST goes through the doors in `prompt-submission.ts` before writing shared
 * state. Everything before the POST runs synchronously, so ownership cannot
 * change there.
 */
export async function handleQuestionResponse(
  responses: QuestionResponseEntry[],
): Promise<void> {
  const { pendingQuestion: snapshot, submittingByKind } =
    useInteractionStore.getState();
  // Guards double-submitting this prompt, not any prompt; see
  // `prompt-submission.ts` for why that is not "anything in flight".
  if (!snapshot || submittingByKind.question === snapshot.requestId) {
    return;
  }
  useInteractionStore
    .getState()
    .claimSubmission("question", snapshot.requestId);
  useChatSessionStore.getState().setError(null);

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    // No ownership check: this runs in the same synchronous block as the entry
    // guard above, so no newer prompt can have arrived yet.
    useChatSessionStore
      .getState()
      .setError({ message: t("chat:promptSubmission.noActiveSession") });
    useInteractionStore
      .getState()
      .releaseSubmission("question", snapshot.requestId);
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
      // The assistant's own message describes a body this client built, so it
      // goes to Sentry rather than in front of the user, who never chose the
      // payload and cannot correct it.
      captureSubmissionRejection("submit_question_response", result);
      reportSubmissionFailure(
        "question",
        snapshot.requestId,
        "questionActions.submitFailed",
      );
      useInteractionStore
        .getState()
        .releaseSubmission("question", snapshot.requestId);
      return;
    }
    // Success. Both writes name this request, so neither can reach a prompt or
    // a submission that is not this one, and the card being gone already (its
    // `interaction_resolved` having arrived first) needs no special case.
    useInteractionStore.getState().dismissQuestionIfMatches(snapshot.requestId);
    useInteractionStore
      .getState()
      .releaseSubmission("question", snapshot.requestId);
  } catch (err) {
    // Transport failure (network drop, abort, malformed response). Always
    // recorded; only shown while its own prompt is the one on screen, so a
    // dead request cannot explain itself over a question it does not belong
    // to.
    captureError(err, { context: "submit_question_response" });
    reportSubmissionFailure(
      "question",
      snapshot.requestId,
      "questionActions.submitFailed",
    );
    useInteractionStore
      .getState()
      .releaseSubmission("question", snapshot.requestId);
  }
}

/**
 * Dismiss (close) the pending question prompt without submitting answers.
 * Sends a "close" signal to the daemon so the turn can proceed.
 */
export function handleDismissPendingQuestion(): void {
  const snapshot = useInteractionStore.getState().pendingQuestion;
  if (!snapshot) {
    return;
  }
  useInteractionStore.getState().dismissQuestionIfMatches(snapshot.requestId);
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
