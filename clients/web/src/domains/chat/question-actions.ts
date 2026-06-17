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
 * Submit the user's answers to a pending question prompt.
 * Guards against a new SSE-driven `question_request` arriving mid-flight
 * by comparing request IDs before clearing state.
 */
export async function handleQuestionResponse(responses: QuestionResponseEntry[]): Promise<void> {
  const { pendingQuestion: snapshot, isSubmittingQuestion } = useInteractionStore.getState();
  if (!snapshot || isSubmittingQuestion) return;
  useInteractionStore.getState().submitQuestionStart();
  useChatSessionStore.getState().setError(null);

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore.getState().setError({ message: "No active session. Please try again." });
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
      useChatSessionStore.getState().setError({ message: result.error });
      useInteractionStore.getState().submitQuestionEnd();
      return;
    }
    if (useInteractionStore.getState().pendingQuestion?.requestId === snapshot.requestId) {
      useInteractionStore.getState().dismissQuestion();
    } else {
      useInteractionStore.getState().submitQuestionEnd();
    }
  } catch (err) {
    captureError(err, { context: "submit_question_response" });
    useChatSessionStore.getState().setError({ message: "Failed to submit response. Please try again." });
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
  if (!snapshot) return;
  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) return;
  submitQuestionResponse(ctx.assistantId, snapshot.requestId, {
    kind: "close",
  })
    .then((result) => {
      if (!result.ok) {
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
