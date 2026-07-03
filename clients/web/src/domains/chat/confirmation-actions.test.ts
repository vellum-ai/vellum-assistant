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

mock.module("@/domains/chat/api/interactions", () => ({
  submitConfirmation: async (
    _assistantId: string,
    requestId: string,
    decision: string,
  ): Promise<SubmitSecretResponseResult> => {
    submitConfirmationCalls.push({ requestId, decision });
    return submitConfirmationResult;
  },
}));

const { handleConfirmationSubmit } = await import(
  "@/domains/chat/confirmation-actions"
);
const { useInteractionStore } = await import(
  "@/domains/chat/interaction-store"
);
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);
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
    expect(useChatSessionStore.getState().error?.message).toBe("Internal error");
  });
});
