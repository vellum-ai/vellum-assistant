/**
 * Reactive safety net for stale question prompts.
 *
 * When the daemon has already discarded a pending interaction (the prompt
 * timed out, the turn was aborted, a newer user message superseded it, or a
 * daemon restart dropped it), `POST /v1/question-response` returns 404. The
 * matching `interaction_resolved` event that would normally retire the card can
 * be missed entirely (the web / iOS SSE stream tears down on app background and
 * has no replay), so the prompt lingers. Answering or closing it must not
 * strand the user on an un-actionable card, nor report an expected outcome as
 * an error.
 *
 * Mirrors `confirmation-actions.test.ts`, which covers the same shape for
 * confirmations.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { SubmitSecretResponseResult } from "@/domains/chat/api/interactions";
import type { QuestionSubmission } from "@/domains/chat/api/event-types";

let submitQuestionResult: SubmitSecretResponseResult = { ok: true };
const submitCalls: Array<{
  requestId: string;
  submission: QuestionSubmission;
}> = [];

/** Runs inside the in-flight POST, to simulate SSE landing mid-request. */
let onSubmit: (() => void) | undefined;

/**
 * Per-requestId gate. A test that registers one holds that request open until
 * it resolves the returned deferred, so two submissions can be genuinely
 * in flight at once.
 */
const deferred = new Map<
  string,
  { promise: Promise<void>; release: () => void }
>();

function holdRequest(requestId: string): void {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  deferred.set(requestId, { promise, release });
}

function releaseRequest(requestId: string): void {
  deferred.get(requestId)?.release();
}

mock.module("@/domains/chat/api/interactions", () => ({
  submitQuestionResponse: async (
    _assistantId: string,
    requestId: string,
    submission: QuestionSubmission,
  ): Promise<SubmitSecretResponseResult> => {
    submitCalls.push({ requestId, submission });
    onSubmit?.();
    const gate = deferred.get(requestId);
    if (gate) {
      await gate.promise;
    }
    return resultByRequestId.get(requestId) ?? submitQuestionResult;
  },
}));

/** Per-requestId results, for tests where two requests resolve differently. */
const resultByRequestId = new Map<string, SubmitSecretResponseResult>();

const capturedErrors: Array<{ context?: string }> = [];
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: (_err: unknown, opts?: { context?: string }) => {
    capturedErrors.push({ context: opts?.context });
  },
}));

const { handleQuestionResponse, handleDismissPendingQuestion } = await import(
  "@/domains/chat/question-actions"
);
const { useInteractionStore } = await import(
  "@/domains/chat/interaction-store"
);
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);
const { useStreamStore } = await import("@/domains/chat/stream-store");

function seedPendingQuestion(requestId: string): void {
  useStreamStore.getState().setStreamContext({
    assistantId: "ast-1",
    conversationId: "conv-1",
  });
  useInteractionStore.getState().showQuestion({
    requestId,
    entries: [
      {
        id: "q1",
        question: "Which Alice?",
        options: [{ id: "alice_work", label: "Alice (work)" }],
      },
    ],
  });
}

/** Let the fire-and-forget close POST settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  submitCalls.length = 0;
  capturedErrors.length = 0;
  onSubmit = undefined;
  deferred.clear();
  resultByRequestId.clear();
  submitQuestionResult = { ok: true };
  useInteractionStore.getState().resetAll();
  useChatSessionStore.getState().setError(null);
  useStreamStore.getState().setStreamContext(null);
});

describe("handleQuestionResponse: stale (404) interaction", () => {
  it("retires the prompt without surfacing a blocking error", async () => {
    submitQuestionResult = {
      ok: false,
      status: 404,
      error: "No pending question interaction found for this requestId",
    };
    seedPendingQuestion("q-stale");

    await handleQuestionResponse([
      { questionId: "q1", kind: "option", optionId: "alice_work" },
    ]);

    expect(submitCalls).toHaveLength(1);
    expect(useInteractionStore.getState().pendingQuestion).toBeNull();
    expect(useInteractionStore.getState().isSubmittingQuestion).toBe(false);
    // The raw server string must never reach the error banner: it renders a
    // "Go to Doctor" CTA for what is an expected, unactionable outcome.
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  it("still surfaces a non-404 failure", async () => {
    submitQuestionResult = {
      ok: false,
      status: 500,
      error: "Internal error",
    };
    seedPendingQuestion("q-broken");

    await handleQuestionResponse([
      { questionId: "q1", kind: "option", optionId: "alice_work" },
    ]);

    // A real server failure is retryable, so the card stays and the user is told.
    expect(useChatSessionStore.getState().error?.message).toBe(
      "Internal error",
    );
    expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe(
      "q-broken",
    );
    expect(useInteractionStore.getState().isSubmittingQuestion).toBe(false);
  });

  it("leaves a newer prompt standing when a stale answer 404s", async () => {
    submitQuestionResult = { ok: false, status: 404, error: "gone" };
    seedPendingQuestion("q-stale");
    // A fresh prompt arrives while the answer is in flight, which is the only
    // way the store can hold a different prompt by the time the 404 lands:
    // `handleQuestionResponse` snapshots the request id at entry.
    onSubmit = () => {
      useInteractionStore
        .getState()
        .showQuestion({ requestId: "q-new", entries: [] });
    };

    await handleQuestionResponse([
      { questionId: "q1", kind: "option", optionId: "alice_work" },
    ]);

    // The stale 404 must retire only the prompt it was answering.
    expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe(
      "q-new",
    );
  });
});

describe("handleQuestionResponse: a late 404 must not rewrite newer state", () => {
  // `isSubmittingQuestion` and the session error are shared, not per-request.
  // The daemon supersedes A with B, which is why A 404s, and `showQuestion`
  // clears `isSubmittingQuestion` when B arrives, so B can already be in flight
  // when A's response lands.
  it("leaves the newer prompt's submitting state intact", async () => {
    holdRequest("q-a");
    resultByRequestId.set("q-a", {
      ok: false,
      status: 404,
      error: "No pending question interaction found for this requestId",
    });
    resultByRequestId.set("q-b", { ok: true });
    holdRequest("q-b");

    seedPendingQuestion("q-a");
    const answerA = handleQuestionResponse([
      { questionId: "q1", kind: "option", optionId: "alice_work" },
    ]);

    // B supersedes A. `showQuestion` resets the submitting flag, so the user
    // can answer B while A is still open.
    useInteractionStore
      .getState()
      .showQuestion({ requestId: "q-b", entries: [] });
    const answerB = handleQuestionResponse([
      { questionId: "q1", kind: "option", optionId: "alice_work" },
    ]);
    expect(useInteractionStore.getState().isSubmittingQuestion).toBe(true);

    // Now A's 404 lands, after B is already in flight.
    releaseRequest("q-a");
    await answerA;

    // B still owns the submitting flag, so its double-submit guard holds.
    expect(useInteractionStore.getState().isSubmittingQuestion).toBe(true);
    expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe(
      "q-b",
    );

    releaseRequest("q-b");
    await answerB;
    expect(submitCalls.map((c) => c.requestId)).toEqual(["q-a", "q-b"]);
  });

  it("leaves the newer prompt's error intact", async () => {
    holdRequest("q-a");
    resultByRequestId.set("q-a", { ok: false, status: 404, error: "gone" });
    resultByRequestId.set("q-b", {
      ok: false,
      status: 500,
      error: "Internal error",
    });

    seedPendingQuestion("q-a");
    const answerA = handleQuestionResponse([
      { questionId: "q1", kind: "option", optionId: "alice_work" },
    ]);

    useInteractionStore
      .getState()
      .showQuestion({ requestId: "q-b", entries: [] });
    await handleQuestionResponse([
      { questionId: "q1", kind: "option", optionId: "alice_work" },
    ]);
    expect(useChatSessionStore.getState().error?.message).toBe(
      "Internal error",
    );

    releaseRequest("q-a");
    await answerA;

    // A's stale cleanup must not erase the failure the user needs to see.
    expect(useChatSessionStore.getState().error?.message).toBe(
      "Internal error",
    );
  });
});

describe("handleDismissPendingQuestion: stale (404) interaction", () => {
  it("does not report a 404 close to Sentry", async () => {
    submitQuestionResult = {
      ok: false,
      status: 404,
      error: "No pending question interaction found for this requestId",
    };
    seedPendingQuestion("q-stale");

    handleDismissPendingQuestion();
    await flush();

    expect(submitCalls).toHaveLength(1);
    expect(useInteractionStore.getState().pendingQuestion).toBeNull();
    // Closing a prompt the daemon already settled is the expected path.
    expect(capturedErrors).toHaveLength(0);
  });

  it("still reports a non-404 close failure", async () => {
    submitQuestionResult = { ok: false, status: 500, error: "boom" };
    seedPendingQuestion("q-broken");

    handleDismissPendingQuestion();
    await flush();

    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0]?.context).toBe("submit_question_response_close");
  });
});
