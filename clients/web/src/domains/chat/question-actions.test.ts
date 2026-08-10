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
    if (throwByRequestId.has(requestId)) {
      throw new Error("network down");
    }
    return resultByRequestId.get(requestId) ?? submitQuestionResult;
  },
}));

/** Requests that reject rather than resolve, modelling a transport failure. */
const throwByRequestId = new Set<string>();

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
  throwByRequestId.clear();
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

/**
 * Start request A, let prompt B supersede it, then start request B, leaving
 * both in flight. Returns A's promise plus a release for it.
 *
 * `isSubmittingQuestion` and the session error are single slots on the store.
 * The daemon supersedes A with B, and `showQuestion` clears
 * `isSubmittingQuestion` when B arrives, so the user can answer B while A is
 * still open. Every completion path of A then lands after ownership has moved.
 */
async function startOverlappingRequests(): Promise<{
  answerA: Promise<void>;
  answerB: Promise<void>;
}> {
  holdRequest("q-a");
  holdRequest("q-b");

  seedPendingQuestion("q-a");
  const answerA = handleQuestionResponse([
    { questionId: "q1", kind: "option", optionId: "alice_work" },
  ]);

  useInteractionStore
    .getState()
    .showQuestion({ requestId: "q-b", entries: [] });
  const answerB = handleQuestionResponse([
    { questionId: "q1", kind: "option", optionId: "alice_work" },
  ]);

  // Both are genuinely in flight, and B owns the shared state.
  expect(submitCalls.map((c) => c.requestId)).toEqual(["q-a", "q-b"]);
  expect(useInteractionStore.getState().isSubmittingQuestion).toBe(true);
  return { answerA, answerB };
}

/** Assert B still owns everything after A landed late. */
function expectBStillOwnsState(): void {
  expect(useInteractionStore.getState().isSubmittingQuestion).toBe(true);
  expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe("q-b");
}

describe("handleQuestionResponse: a late completion must not rewrite newer state", () => {
  it("stale A 404 leaves B's pending/submitting state intact", async () => {
    resultByRequestId.set("q-a", {
      ok: false,
      status: 404,
      error: "No pending question interaction found for this requestId",
    });
    const { answerA, answerB } = await startOverlappingRequests();

    releaseRequest("q-a");
    await answerA;

    expectBStillOwnsState();
    expect(useChatSessionStore.getState().error).toBeNull();

    releaseRequest("q-b");
    await answerB;
  });

  it("stale A success leaves B's pending/submitting state intact", async () => {
    // The success path is the sharpest case: its card-retiring branch compares
    // request ids, so the fallback branch fires precisely when B owns the state.
    resultByRequestId.set("q-a", { ok: true });
    const { answerA, answerB } = await startOverlappingRequests();

    releaseRequest("q-a");
    await answerA;

    expectBStillOwnsState();

    releaseRequest("q-b");
    await answerB;
  });

  it("stale A non-404 failure leaves B's pending/submitting state intact", async () => {
    resultByRequestId.set("q-a", {
      ok: false,
      status: 500,
      error: "A exploded",
    });
    const { answerA, answerB } = await startOverlappingRequests();

    releaseRequest("q-a");
    await answerA;

    expectBStillOwnsState();
    // A's failure belongs to a prompt the user can no longer see.
    expect(useChatSessionStore.getState().error).toBeNull();

    releaseRequest("q-b");
    await answerB;
  });

  it("stale A transport failure leaves B's pending/submitting state intact", async () => {
    throwByRequestId.add("q-a");
    const { answerA, answerB } = await startOverlappingRequests();

    releaseRequest("q-a");
    await answerA;

    expectBStillOwnsState();
    expect(useChatSessionStore.getState().error).toBeNull();
    // The throw is still reported: suppressing the banner is not suppressing
    // telemetry.
    expect(capturedErrors.map((e) => e.context)).toContain(
      "submit_question_response",
    );

    releaseRequest("q-b");
    await answerB;
  });

  it("B's error survives A's late completion", async () => {
    // B fails for real while A is still open; A must not erase the banner.
    resultByRequestId.set("q-a", { ok: false, status: 404, error: "gone" });
    resultByRequestId.set("q-b", {
      ok: false,
      status: 500,
      error: "Internal error",
    });
    const { answerA, answerB } = await startOverlappingRequests();

    releaseRequest("q-b");
    await answerB;
    expect(useChatSessionStore.getState().error?.message).toBe(
      "Internal error",
    );

    releaseRequest("q-a");
    await answerA;

    expect(useChatSessionStore.getState().error?.message).toBe(
      "Internal error",
    );
  });

  it("still cleans up its own state when no newer prompt took over", async () => {
    // The guard must not strand the submitting flag in the ordinary case where
    // the card was retired by `interaction_resolved` mid-flight.
    resultByRequestId.set("q-a", { ok: false, status: 500, error: "boom" });
    holdRequest("q-a");
    seedPendingQuestion("q-a");
    const answerA = handleQuestionResponse([
      { questionId: "q1", kind: "option", optionId: "alice_work" },
    ]);
    useInteractionStore.getState().dismissQuestionIfMatches("q-a");

    releaseRequest("q-a");
    await answerA;

    expect(useInteractionStore.getState().isSubmittingQuestion).toBe(false);
    expect(useChatSessionStore.getState().error?.message).toBe("boom");
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
