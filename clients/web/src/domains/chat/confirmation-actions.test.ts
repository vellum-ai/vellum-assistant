/**
 * Reactive safety net for stale confirmation prompts.
 *
 * When the daemon has already discarded a pending interaction (the turn
 * ended, the tool call timed out, the prompt was superseded, or a daemon
 * restart dropped it), `POST /v1/confirm` returns 404. The matching
 * `interaction_resolved` SSE event that would normally retire the card can be
 * missed entirely (the web / iOS SSE stream tears down on app background and
 * has no replay), so the prompt lingers. Tapping Allow/Deny must not strand
 * the user on an un-actionable card.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { SubmitSecretResponseResult } from "@/domains/chat/api/interactions";

let submitConfirmationResult: SubmitSecretResponseResult = { ok: true };
const submitConfirmationCalls: Array<{ requestId: string; decision: string }> =
  [];
/** Held open by the ownership tests so the slot can move mid-submit. */
let submitGate: Promise<void> | null = null;

mock.module("@/domains/chat/api/interactions", () => ({
  submitConfirmation: async (
    _assistantId: string,
    requestId: string,
    decision: string,
  ): Promise<SubmitSecretResponseResult> => {
    submitConfirmationCalls.push({ requestId, decision });
    if (submitGate) {
      await submitGate;
    }
    return submitConfirmationResult;
  },
}));

const { handleConfirmationSubmit } =
  await import("@/domains/chat/confirmation-actions");
const { useInteractionStore } =
  await import("@/domains/chat/interaction-store");
const { useChatSessionStore } =
  await import("@/domains/chat/chat-session-store");
const { useStreamStore } = await import("@/domains/chat/stream-store");

function seedPendingConfirmation(requestId: string): void {
  useStreamStore.getState().setStreamContext({
    assistantId: "ast-1",
    conversationId: "conv-1",
  });
  useInteractionStore.getState().showConfirmation({
    requestId,
    toolName: "acp_spawn",
    riskLevel: "high",
    input: {},
  });
}

beforeEach(() => {
  submitConfirmationCalls.length = 0;
  submitConfirmationResult = { ok: true };
  submitGate = null;
  useInteractionStore.getState().resetAll();
  useChatSessionStore.getState().setError(null);
  useStreamStore.getState().setStreamContext(null);
});

describe("handleConfirmationSubmit — stale (404) interaction", () => {
  it("retires the prompt without surfacing a blocking error", async () => {
    submitConfirmationResult = {
      ok: false,
      status: 404,
      error: "No pending interaction found for this requestId",
    };
    seedPendingConfirmation("cr-stale");

    await handleConfirmationSubmit("allow");

    expect(submitConfirmationCalls).toHaveLength(1);
    expect(useInteractionStore.getState().pendingConfirmation).toBeNull();
    expect(useInteractionStore.getState().isSubmittingConfirmation).toBe(false);
    // No error banner — the user is not stranded on an un-actionable card.
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  it("still surfaces an error for non-404 failures", async () => {
    submitConfirmationResult = {
      ok: false,
      status: 500,
      error: "Internal error",
    };
    seedPendingConfirmation("cr-500");

    await handleConfirmationSubmit("deny");

    // The prompt stays so the user can retry a transient failure.
    expect(useInteractionStore.getState().pendingConfirmation?.requestId).toBe(
      "cr-500",
    );
    expect(useChatSessionStore.getState().error?.message).toBe(
      "Internal error",
    );
  });
});

describe("handleConfirmationSubmit: a resume that no longer owns the state", () => {
  /** Starts a submit that parks inside the request, and returns the release. */
  function submitParked(decision: "allow" | "deny"): {
    inFlight: Promise<void>;
    release: () => void;
  } {
    let release: (() => void) | undefined;
    submitGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = handleConfirmationSubmit(decision);
    return { inFlight, release: () => release?.() };
  }

  it("leaves a newer prompt alone when a late response lands", async () => {
    // GIVEN a submission parked mid-request
    submitConfirmationResult = {
      ok: false,
      status: 500,
      error: "Internal error",
    };
    seedPendingConfirmation("cr-old");
    const { inFlight, release } = submitParked("allow");

    // WHEN a different confirmation takes the slot before the response lands
    useInteractionStore.getState().showConfirmation({
      requestId: "cr-new",
      toolName: "bash",
      riskLevel: "low",
      input: {},
    });

    release();
    await inFlight;

    // THEN the newer prompt keeps its card, and the dead request's error is
    // not shown in its place
    expect(submitConfirmationCalls).toHaveLength(1);
    expect(useInteractionStore.getState().pendingConfirmation?.requestId).toBe(
      "cr-new",
    );
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  it("stands down when another prompt came and went during the request", async () => {
    // GIVEN a submission parked mid-request, with its own prompt in the slot
    // so the guarded path is genuinely reached
    submitConfirmationResult = {
      ok: false,
      status: 500,
      error: "Internal error",
    };
    seedPendingConfirmation("cr-aba");
    const { inFlight, release } = submitParked("allow");

    // WHEN its prompt settles and a different one comes and goes, returning
    // the slot to the null it would have reached anyway
    useInteractionStore.getState().dismissConfirmationIfMatches("cr-aba");
    useInteractionStore.getState().showConfirmation({
      requestId: "cr-transient",
      toolName: "bash",
      riskLevel: "low",
      input: {},
    });
    useInteractionStore.getState().dismissConfirmationIfMatches("cr-transient");
    expect(useInteractionStore.getState().pendingConfirmation).toBeNull();

    release();
    await inFlight;

    // THEN nothing is written. The slot ends on the same null the submission
    // would have left behind, so only the id of whoever left last can tell
    // this apart from its own resolution.
    expect(submitConfirmationCalls).toHaveLength(1);
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  it("still cleans up when its own resolution retired the card first", async () => {
    // GIVEN a submission parked mid-request. The daemon broadcasts
    // `interaction_resolved` before its POST response returns, so this is the
    // ordinary ordering rather than an edge case.
    submitConfirmationResult = { ok: true };
    seedPendingConfirmation("cr-self");
    useChatSessionStore.getState().setError({ message: "stale banner" });
    const { inFlight, release } = submitParked("allow");

    // WHEN the matching resolution lands first and retires the card
    useInteractionStore.getState().dismissConfirmationIfMatches("cr-self");

    release();
    await inFlight;

    // THEN the resume still finishes its own cleanup, rather than mistaking
    // its own resolution for someone else taking the slot
    expect(useInteractionStore.getState().isSubmittingConfirmation).toBe(false);
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  it("keeps ownership across a re-show of the same request", async () => {
    // GIVEN a submission parked mid-request
    submitConfirmationResult = { ok: true };
    seedPendingConfirmation("cr-reshow");
    const { inFlight, release } = submitParked("allow");

    // WHEN the same prompt is re-raised (an SSE re-emit or a reseed)
    useInteractionStore.getState().showConfirmation({
      requestId: "cr-reshow",
      toolName: "acp_spawn",
      riskLevel: "high",
      input: {},
    });

    release();
    await inFlight;

    // THEN it is still this submission's prompt, so the decision applies
    expect(useInteractionStore.getState().pendingConfirmation).toBeNull();
  });

  it("still applies when the submission is the only one in play", async () => {
    submitConfirmationResult = { ok: true };
    seedPendingConfirmation("cr-solo");

    await handleConfirmationSubmit("allow");

    expect(useInteractionStore.getState().pendingConfirmation).toBeNull();
    expect(useInteractionStore.getState().isSubmittingConfirmation).toBe(false);
  });
});

describe("handleConfirmationSubmit — risk metadata stamping", () => {
  function seedSnapshotWithFinishedCall(): void {
    useChatSessionStore.setState({
      snapshot: {
        messages: [
          {
            id: "a-1",
            role: "assistant",
            toolCalls: [
              // Finished and unstamped: what the deleted heuristic used to
              // seize on when a prompt named no tool call.
              { id: "tc-unrelated", name: "bash", input: {}, result: "ok" },
            ],
          },
        ],
      },
    } as never);
  }

  it("does not stamp an unrelated tool call when the prompt named none", async () => {
    seedSnapshotWithFinishedCall();
    seedPendingConfirmation("cr-1");

    await handleConfirmationSubmit("allow");

    const stamped = (
      useChatSessionStore.getState().snapshot?.messages ?? []
    ).flatMap((m) =>
      (m.toolCalls ?? []).filter((tc) => tc.confirmationDecision !== undefined),
    );
    // Risk metadata describes a tool call; a prompt with none has nothing to
    // describe, so labelling the last finished step with this decision's risk
    // is wrong about a step the user never approved.
    expect(stamped).toEqual([]);
  });

  it("raises no unknown-risk nudge when the prompt named no tool call", async () => {
    seedSnapshotWithFinishedCall();
    useStreamStore.getState().setStreamContext({
      assistantId: "ast-1",
      conversationId: "conv-1",
    });
    useInteractionStore.getState().showConfirmation({
      requestId: "cr-2",
      toolName: "acp_spawn",
      riskLevel: "unknown",
      input: {},
    });

    await handleConfirmationSubmit("allow");

    expect(useInteractionStore.getState().unknownNudgeToolCallIds.size).toBe(0);
  });
});
