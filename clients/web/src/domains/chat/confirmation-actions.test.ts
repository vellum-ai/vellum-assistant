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

mock.module("@/domains/chat/rule-editor-actions", () => ({
  // The suggestion request is a live fetch and irrelevant here; the editor
  // opening is asserted through the rule-editor store instead.
  fireSuggestion: () => {},
}));

const { handleAllowAndCreateRule, handleConfirmationSubmit } =
  await import("@/domains/chat/confirmation-actions");
const { useInteractionStore } =
  await import("@/domains/chat/interaction-store");
const { useChatSessionStore } =
  await import("@/domains/chat/chat-session-store");
const { useStreamStore } = await import("@/domains/chat/stream-store");
const { useRuleEditorStore } = await import("@/domains/chat/rule-editor-store");

/**
 * Every requestId whose `releaseSubmission` call actually moved the slot.
 *
 * Recorded from the caller's own id rather than from the slot's outgoing
 * value: an unscoped release by a stale request and a correct release by the
 * holder both take the same value out, so only the caller distinguishes them.
 */
const releasedBy: string[] = [];

const realReleaseSubmission = useInteractionStore.getState().releaseSubmission;
useInteractionStore.setState({
  releaseSubmission: (kind, requestId) => {
    const before = useInteractionStore.getState().submittingByKind[kind];
    realReleaseSubmission(kind, requestId);
    if (useInteractionStore.getState().submittingByKind[kind] !== before) {
      releasedBy.push(requestId);
    }
  },
});

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
  releasedBy.length = 0;
  submitConfirmationResult = { ok: true };
  submitGate = null;
  useInteractionStore.getState().resetAll();
  useChatSessionStore.getState().setError(null);
  useStreamStore.getState().setStreamContext(null);
  useRuleEditorStore.setState({
    ruleEditorContext: null,
    showRuleEditor: false,
  });
});

describe("handleConfirmationSubmit — stale (404) interaction", () => {
  it("retires the prompt without surfacing a blocking error", async () => {
    submitConfirmationResult = {
      ok: false,
      status: 404,
      error: "No pending interaction found for this requestId",
      transient: false,
    };
    seedPendingConfirmation("cr-stale");

    await handleConfirmationSubmit("allow");

    expect(submitConfirmationCalls).toHaveLength(1);
    expect(useInteractionStore.getState().pendingConfirmation).toBeNull();
    expect(
      useInteractionStore.getState().submittingByKind.confirmation,
    ).toBeNull();
    // No error banner — the user is not stranded on an un-actionable card.
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  it("still surfaces an error for non-404 failures", async () => {
    submitConfirmationResult = {
      ok: false,
      status: 500,
      error: "Internal error",
      transient: false,
    };
    seedPendingConfirmation("cr-500");

    await handleConfirmationSubmit("deny");

    // The prompt stays so the user can retry a transient failure.
    expect(useInteractionStore.getState().pendingConfirmation?.requestId).toBe(
      "cr-500",
    );
    // Copy the user can read, not the assistant's rejection text.
    expect(useChatSessionStore.getState().error?.message).toBe(
      "Failed to submit confirmation. Please try again.",
    );
  });
});

describe("handleConfirmationSubmit: a resume that no longer owns the slot", () => {
  /** Starts a submit that parks inside the request, and returns the release. */
  function submitParked(
    decision: "allow" | "deny",
    toolCall?: Parameters<typeof handleConfirmationSubmit>[1],
  ): { inFlight: Promise<void>; release: () => void } {
    let release: (() => void) | undefined;
    submitGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = handleConfirmationSubmit(decision, toolCall);
    return { inFlight, release: () => release?.() };
  }

  it("does not release a newer submission's guard", () => {
    // GIVEN one submission parked mid-request, and a second started from an
    // inline card, which is the path that can begin while another is in flight
    submitConfirmationResult = { ok: true };
    seedPendingConfirmation("cr-old");
    const first = submitParked("allow");
    const second = submitParked("allow", {
      id: "tc-1",
      name: "bash",
      input: {},
      pendingConfirmation: { requestId: "cr-new", riskLevel: "low", input: {} },
    } as Parameters<typeof handleConfirmationSubmit>[1]);

    // THEN the slot belongs to the newer submission
    expect(useInteractionStore.getState().submittingByKind.confirmation).toBe(
      "cr-new",
    );

    // WHEN the older response lands afterwards
    first.release();
    second.release();

    return Promise.all([first.inFlight, second.inFlight]).then(() => {
      expect(submitConfirmationCalls).toHaveLength(2);
      // The older resume must neither take the slot back nor free it. Both
      // requests succeed here, so the slot ends up released by its own holder
      // — the assertion that matters is that `cr-new` is the one that did it,
      // which a call count cannot show.
      expect(releasedBy).toEqual(["cr-new"]);
      expect(
        useInteractionStore.getState().submittingByKind.confirmation,
      ).toBeNull();
    });
  });

  it("ignores a second click on the prompt it is already submitting", async () => {
    // GIVEN a submission parked mid-request
    submitConfirmationResult = { ok: true };
    seedPendingConfirmation("cr-double");
    const { inFlight, release } = submitParked("allow");

    // WHEN the same prompt is submitted again
    await handleConfirmationSubmit("allow");

    // THEN the second click does nothing. This is the case the entry guard
    // exists for, and it is about this prompt rather than about any prompt: a
    // superseding confirmation stays answerable while this one is on the wire.
    expect(submitConfirmationCalls).toHaveLength(1);

    release();
    await inFlight;
  });

  it("stands down after a reset abandoned the interaction", async () => {
    submitConfirmationResult = {
      ok: false,
      status: 500,
      error: "Internal error",
      transient: false,
    };
    seedPendingConfirmation("cr-reset");
    const { inFlight, release } = submitParked("allow");

    // WHEN a reset abandons the interaction outright, which is what a
    // superseding user message does
    useInteractionStore.getState().resetSecretAndConfirmation();

    release();
    await inFlight;

    // THEN the resume writes nothing: a reset is the one event that genuinely
    // ends someone else's submission
    expect(submitConfirmationCalls).toHaveLength(1);
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  it("still cleans up when its own resolution retired the card first", async () => {
    // GIVEN a submission parked mid-request. The daemon broadcasts
    // `interaction_resolved` before its POST response returns, so this is the
    // ordinary ordering rather than an edge case.
    submitConfirmationResult = { ok: true };
    seedPendingConfirmation("cr-self");
    const { inFlight, release } = submitParked("allow");

    // WHEN the matching resolution lands first and retires the card
    useInteractionStore.getState().dismissConfirmationIfMatches("cr-self");
    // The submission is untouched by that: the card's lifecycle and the
    // request's are separate.
    expect(useInteractionStore.getState().submittingByKind.confirmation).toBe(
      "cr-self",
    );

    release();
    await inFlight;

    // THEN it finishes its own cleanup and releases its own slot
    expect(
      useInteractionStore.getState().submittingByKind.confirmation,
    ).toBeNull();
  });

  it("keeps the slot across a re-show of the same request", async () => {
    submitConfirmationResult = { ok: true };
    seedPendingConfirmation("cr-reshow");
    const { inFlight, release } = submitParked("allow");

    // An SSE re-emit or a reseed raises the same prompt again
    useInteractionStore.getState().showConfirmation({
      requestId: "cr-reshow",
      toolName: "acp_spawn",
      riskLevel: "high",
      input: {},
    });
    // Asserted here rather than only through the outcome: the re-show is the
    // same request, so it must not move the slot out from under its own
    // submission.
    expect(useInteractionStore.getState().submittingByKind.confirmation).toBe(
      "cr-reshow",
    );

    release();
    await inFlight;

    expect(useInteractionStore.getState().pendingConfirmation).toBeNull();
    expect(
      useInteractionStore.getState().submittingByKind.confirmation,
    ).toBeNull();
  });

  it("retires only the card its decision was made on", async () => {
    // GIVEN a submission parked mid-request whose prompt is then superseded by
    // a different one on screen
    submitConfirmationResult = { ok: true };
    seedPendingConfirmation("cr-answered");
    const { inFlight, release } = submitParked("allow");
    useInteractionStore.getState().showConfirmation({
      requestId: "cr-other",
      toolName: "bash",
      riskLevel: "low",
      input: {},
    });

    release();
    await inFlight;

    // THEN the card the user is looking at survives: the cleanup names the
    // request it decided, so it cannot reach another one
    expect(useInteractionStore.getState().pendingConfirmation?.requestId).toBe(
      "cr-other",
    );
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

describe("handleAllowAndCreateRule: a resume that no longer owns the slot", () => {
  /** Start a rule-editor allow that parks inside the request. */
  function allowParked(): { inFlight: Promise<void>; release: () => void } {
    let release: (() => void) | undefined;
    submitGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = handleAllowAndCreateRule();
    return { inFlight, release: () => release?.() };
  }

  /** Raise a second prompt and answer it, so the slot moves to it. */
  function supersedeWith(requestId: string): {
    inFlight: Promise<void>;
    release: () => void;
  } {
    useInteractionStore.getState().showConfirmation({
      requestId,
      toolName: "bash",
      riskLevel: "low",
      input: {},
    });
    let release: (() => void) | undefined;
    submitGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = handleConfirmationSubmit("allow");
    expect(useInteractionStore.getState().submittingByKind.confirmation).toBe(
      requestId,
    );
    return { inFlight, release: () => release?.() };
  }

  it("keeps a superseded request's failure off the prompt on screen", async () => {
    // GIVEN a rule-editor allow parked mid-request, superseded by a prompt the
    // user then answers
    seedPendingConfirmation("cr-a");
    const a = allowParked();
    const b = supersedeWith("cr-b");

    submitConfirmationResult = {
      ok: false,
      status: 500,
      error: "A exploded",
      transient: false,
    };
    a.release();
    await a.inFlight;

    // THEN A's failure names a prompt the user can no longer see
    expect(useChatSessionStore.getState().error).toBeNull();
    expect(useInteractionStore.getState().submittingByKind.confirmation).toBe(
      "cr-b",
    );
    expect(useInteractionStore.getState().pendingConfirmation?.requestId).toBe(
      "cr-b",
    );
    // The editor still opens: it is this user's own click, and withholding it
    // would swallow the action they took.
    expect(useRuleEditorStore.getState().ruleEditorContext).not.toBeNull();

    b.release();
    await b.inFlight;
  });

  it("does not clear a newer prompt's banner when it 404s", async () => {
    // A 404 retires this prompt quietly, which means clearing its own banner
    // — not one raised for the prompt the user is looking at.
    seedPendingConfirmation("cr-a");
    const a = allowParked();
    const b = supersedeWith("cr-b");
    useChatSessionStore.getState().setError({ message: "B exploded" });

    submitConfirmationResult = {
      ok: false,
      status: 404,
      error: "gone",
      transient: false,
    };
    a.release();
    await a.inFlight;

    expect(useChatSessionStore.getState().error?.message).toBe("B exploded");

    b.release();
    await b.inFlight;
  });

  it("still surfaces its own failure when nothing superseded it", async () => {
    // The guard must not swallow the ordinary failure it is scoped around.
    seedPendingConfirmation("cr-solo");
    submitConfirmationResult = {
      ok: false,
      status: 500,
      error: "boom",
      transient: false,
    };

    await handleAllowAndCreateRule();

    expect(useChatSessionStore.getState().error?.message).toBe(
      "Failed to submit confirmation, but you can still create a rule.",
    );
    expect(
      useInteractionStore.getState().submittingByKind.confirmation,
    ).toBeNull();
  });
});
