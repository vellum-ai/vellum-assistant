/**
 * Tests for `handleSecretCancel` — verifies it resolves the pending
 * interaction on the daemon by posting ONLY `{ requestId }` (no `value`,
 * no `delivery`), which the daemon treats as cancellation.
 *
 * We mock the generated `secretPost` SDK call so we can assert the exact
 * request body, and mock `turn-coordinator` to keep the test focused.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

interface CapturedRequest {
  body: Record<string, unknown>;
}

const requests: CapturedRequest[] = [];

mock.module("@/generated/daemon/sdk.gen", () => ({
  secretPost: async ({ body }: { body: Record<string, unknown> }) => {
    requests.push({ body });
    return { error: undefined, response: new Response(null, { status: 200 }) };
  },
}));

mock.module("@/domains/chat/turn-coordinator", () => ({
  endTurn: mock(() => {}),
}));

import { handleSecretCancel } from "@/domains/chat/secret-actions";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useConversationStore } from "@/stores/conversation-store";

afterEach(() => {
  requests.length = 0;
  useInteractionStore.getState().resetAll();
  useStreamStore.setState({ streamContext: null });
  useConversationStore.setState({ activeConversationId: null });
});

describe("handleSecretCancel", () => {
  it("posts a {requestId}-only cancel with no value or delivery", async () => {
    useStreamStore.setState({
      streamContext: { assistantId: "assistant-1", conversationId: "conv-1" },
    });
    useInteractionStore.getState().showSecret({ requestId: "req-1", label: "API Key" });

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
