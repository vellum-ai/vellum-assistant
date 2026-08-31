/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The Connect card must not move while the user is connecting.
 *
 * Moving it between the transcript tree and the composer tree unmounts the
 * affordance and mounts a new one. The affordance owns the OAuth flow, so that
 * cancels the loopback poll and discards the manual paste state, and the
 * replacement starts back at `idle` with no way to finish a sign-in already in
 * progress. The user sending another message is exactly what would move it,
 * and they can do that while a tab is away at the consent screen.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { DisplayMessage } from "@/domains/chat/types/types";

let mockMessages: DisplayMessage[] = [];
mock.module("@/domains/chat/transcript/use-transcript-messages", () => ({
  useTranscriptMessages: () => mockMessages,
}));

const { useInteractionStore } =
  await import("@/domains/chat/interaction-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useAcpConnectPlacement } =
  await import("@/domains/chat/hooks/use-acp-connect-placement");

const ANCHOR = "tool-anchor";

function assistantWithAnchor(): DisplayMessage {
  return {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [{ id: ANCHOR, name: "acp_spawn" }],
  } as any;
}

function userMessage(id: string): DisplayMessage {
  return { id, role: "user", content: "anything" } as any;
}

beforeEach(() => {
  mockMessages = [assistantWithAnchor()];
  useConversationStore.setState({ activeConversationId: "conv-1" } as never);
  useInteractionStore.setState({
    pendingAcpConnect: {
      toolUseId: ANCHOR,
      reason: "auth_required",
      conversationId: "conv-1",
    },
    dismissedAcpConnectToolUseIds: new Set<string>(),
    acpConnectFlowActive: false,
    acpConnectPlacement: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("useAcpConnectPlacement: holding position during a flow", () => {
  test("a new user message docks the card when no flow is running", () => {
    const { result, rerender } = renderHook(() => useAcpConnectPlacement());
    expect(result.current).toBe("inline");

    mockMessages = [assistantWithAnchor(), userMessage("u2")];
    rerender();

    expect(result.current).toBe("docked");
  });

  test("a new user message does not move the card mid-flow", () => {
    const { result, rerender } = renderHook(() => useAcpConnectPlacement());
    expect(result.current).toBe("inline");

    useInteractionStore.getState().setAcpConnectFlowActive(true);
    mockMessages = [assistantWithAnchor(), userMessage("u2")];
    rerender();

    expect(result.current).toBe("inline");
  });

  test("the card moves once the flow is over", () => {
    const { result, rerender } = renderHook(() => useAcpConnectPlacement());
    useInteractionStore.getState().setAcpConnectFlowActive(true);
    mockMessages = [assistantWithAnchor(), userMessage("u2")];
    rerender();
    expect(result.current).toBe("inline");

    useInteractionStore.getState().setAcpConnectFlowActive(false);
    rerender();

    expect(result.current).toBe("docked");
  });

  test("a different prompt is placed on its own merits, not the last one's", () => {
    const { result, rerender } = renderHook(() => useAcpConnectPlacement());
    useInteractionStore.getState().setAcpConnectFlowActive(true);
    rerender();
    expect(result.current).toBe("inline");

    // A newer failure raises a prompt whose anchor is not in the transcript.
    useInteractionStore.setState({
      pendingAcpConnect: {
        toolUseId: "tool-other",
        reason: "auth_required",
        conversationId: "conv-1",
      },
    });
    rerender();

    expect(result.current).toBe("docked");
  });
});
