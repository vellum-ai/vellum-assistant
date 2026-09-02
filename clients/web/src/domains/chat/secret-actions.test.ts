/**
 * Tests for the secret-prompt handlers.
 *
 * `handleSecretCancel` must resolve the pending interaction on the daemon by
 * posting ONLY `{ requestId }` (no `value`, no `delivery`), which the daemon
 * treats as cancellation. `handleSecretSubmit` must keep a superseded
 * request's outcome off the prompt the user is actually looking at.
 *
 * We mock the generated `secretPost` SDK call so we can assert the exact
 * request body, and mock `turn-coordinator` to keep the test focused.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

interface CapturedRequest {
  body: Record<string, unknown>;
}

const requests: CapturedRequest[] = [];
/** Held open by the ownership test so the slot can move mid-submit. */
const gateByRequestId = new Map<string, Promise<void>>();
/** Response status per requestId; anything absent succeeds. */
const statusByRequestId = new Map<string, number>();

mock.module("@/generated/daemon/sdk.gen", () => ({
  secretPost: async ({ body }: { body: Record<string, unknown> }) => {
    requests.push({ body });
    const requestId = String(body.requestId);
    const gate = gateByRequestId.get(requestId);
    if (gate) {
      await gate;
    }
    const status = statusByRequestId.get(requestId) ?? 200;
    return {
      error: status === 200 ? undefined : { message: "Secret store offline" },
      response: new Response(null, { status }),
    };
  },
}));

mock.module("@/domains/chat/turn-coordinator", () => ({
  endTurn: mock(() => {}),
}));

import {
  handleSecretCancel,
  handleSecretSubmit,
} from "@/domains/chat/secret-actions";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useConversationStore } from "@/stores/conversation-store";

afterEach(() => {
  requests.length = 0;
  gateByRequestId.clear();
  statusByRequestId.clear();
  useChatSessionStore.getState().setError(null);
  useInteractionStore.getState().resetAll();
  useStreamStore.setState({ streamContext: null });
  useConversationStore.setState({ activeConversationId: null });
});

describe("handleSecretCancel", () => {
  it("posts a {requestId}-only cancel with no value or delivery", async () => {
    useStreamStore.setState({
      streamContext: { assistantId: "assistant-1", conversationId: "conv-1" },
    });
    useInteractionStore
      .getState()
      .showSecret({ requestId: "req-1", label: "API Key" });

    handleSecretCancel();

    // The cancel POST is fire-and-forget; let the microtask settle.
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    const { body } = requests[0]!;
    expect(body.requestId).toBe("req-1");
    expect(body).not.toHaveProperty("value");
    expect(body).not.toHaveProperty("delivery");
  });

  it("clears the pending secret locally", () => {
    useStreamStore.setState({
      streamContext: { assistantId: "assistant-1", conversationId: "conv-1" },
    });
    useInteractionStore.getState().showSecret({ requestId: "req-1" });

    handleSecretCancel();

    expect(useInteractionStore.getState().pendingSecret).toBeNull();
  });

  it("is a no-op POST when there is no pending secret", () => {
    useStreamStore.setState({
      streamContext: { assistantId: "assistant-1", conversationId: "conv-1" },
    });

    handleSecretCancel();

    expect(requests).toHaveLength(0);
  });
});

describe("handleSecretSubmit: a resume that no longer owns the slot", () => {
  /** Park `requestId` inside its POST and return the release. */
  function park(requestId: string): () => void {
    let release: (() => void) | undefined;
    gateByRequestId.set(
      requestId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => release?.();
  }

  it("keeps a superseded request's failure off the prompt on screen", async () => {
    useStreamStore.setState({
      streamContext: { assistantId: "assistant-1", conversationId: "conv-1" },
    });
    // GIVEN request A parked mid-POST and destined to fail
    statusByRequestId.set("req-a", 500);
    const releaseA = park("req-a");
    useInteractionStore.getState().showSecret({ requestId: "req-a" });
    const submitA = handleSecretSubmit("hunter2");

    // WHEN prompt B supersedes it and takes the slot, still unanswered
    useInteractionStore.getState().showSecret({ requestId: "req-b" });
    useInteractionStore.getState().claimSubmission("secret", "req-b");

    releaseA();
    await submitA;

    // THEN A's failure names a prompt the user can no longer see, so it must
    // not appear over B, and it must not free B's slot.
    expect(useChatSessionStore.getState().error).toBeNull();
    expect(useInteractionStore.getState().submittingByKind.secret).toBe(
      "req-b",
    );
    expect(useInteractionStore.getState().pendingSecret?.requestId).toBe(
      "req-b",
    );
  });

  it("still surfaces its own failure when nothing superseded it", async () => {
    // The guard must not swallow the ordinary failure it is scoped around.
    useStreamStore.setState({
      streamContext: { assistantId: "assistant-1", conversationId: "conv-1" },
    });
    statusByRequestId.set("req-solo", 500);
    useInteractionStore.getState().showSecret({ requestId: "req-solo" });

    await handleSecretSubmit("hunter2");

    expect(useChatSessionStore.getState().error?.message).toBeTruthy();
    expect(useInteractionStore.getState().submittingByKind.secret).toBeNull();
  });
});
