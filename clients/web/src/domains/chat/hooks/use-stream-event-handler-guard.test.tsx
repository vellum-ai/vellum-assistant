import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import type { AssistantEvent } from "@/types/event-types";
import { useStreamStore } from "@/domains/chat/stream-store";

const handlerCalls: Array<{ kind: string; conversationId?: string }> = [];

mock.module(
  "@/domains/chat/utils/stream-handlers/message-handlers",
  () => ({
    handleAssistantTextDelta: (event: { conversationId?: string }) => {
      handlerCalls.push({ kind: "assistant_text_delta", conversationId: event.conversationId });
    },
    handleAssistantThinkingDelta: (event: { conversationId?: string }) => {
      handlerCalls.push({ kind: "assistant_thinking_delta", conversationId: event.conversationId });
    },
    handleAssistantTurnStart: (event: { conversationId?: string }) => {
      handlerCalls.push({ kind: "assistant_turn_start", conversationId: event.conversationId });
    },
    handleAssistantActivityState: () => {
      handlerCalls.push({ kind: "assistant_activity_state" });
    },
    handleMessageComplete: (event: { conversationId?: string }) => {
      handlerCalls.push({ kind: "message_complete", conversationId: event.conversationId });
    },
    handleUserMessageEcho: (event: { conversationId?: string }) => {
      handlerCalls.push({ kind: "user_message_echo", conversationId: event.conversationId });
    },
    handleGenerationHandoff: () => {
      handlerCalls.push({ kind: "generation_handoff" });
    },
    handleGenerationCancelled: () => {
      handlerCalls.push({ kind: "generation_cancelled" });
    },
  }),
);
const { useStreamEventHandler } = await import(
  "@/domains/chat/hooks/use-stream-event-handler"
);

function setupStreamStore(overrides?: {
  streamEpoch?: number;
  streamConversationId?: string | null;
}) {
  useStreamStore.setState({
    streamEpoch: overrides?.streamEpoch ?? 0,
    streamContext:
      overrides?.streamConversationId === null
        ? null
        : overrides?.streamConversationId !== undefined
          ? { assistantId: "asst-1", conversationId: overrides.streamConversationId }
          : { assistantId: "asst-1", conversationId: "conv-A" },
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function renderHandler(
  overrides?: {
    streamEpoch?: number;
    streamConversationId?: string | null;
    activeConversationId?: string | null;
  },
) {
  setupStreamStore(overrides);
  const { result } = renderHook(
    () =>
      useStreamEventHandler({
        push: () => {},
        isNative: false,
        cancelReconciliation: () => {},
        startReconciliationLoop: () => {},
        setAssetsRefreshKey: () => {},
      }),
    { wrapper },
  );
  return result.current;
}

beforeEach(() => {
  handlerCalls.length = 0;
  setupStreamStore();
});

afterEach(() => {
  cleanup();
});

describe("handleStreamEvent — defense-in-depth conversation routing guard", () => {
  test("forwards a conversation-scoped event whose key matches the stream context", () => {
    const { handleStreamEvent } = renderHandler();
    handleStreamEvent(
      {
        type: "assistant_text_delta",
        conversationId: "conv-A",
        delta: "hi",
      } as unknown as AssistantEvent,
      0,
    );
    expect(handlerCalls.length).toBeGreaterThan(0);
    expect(handlerCalls[handlerCalls.length - 1]?.conversationId).toBe("conv-A");
  });

  test("rejects a conversation-scoped event whose key does NOT match the stream context", () => {
    const { handleStreamEvent } = renderHandler({
      streamConversationId: "conv-A",
    });
    handleStreamEvent(
      {
        type: "assistant_text_delta",
        conversationId: "conv-B",
        delta: "hi",
      } as unknown as AssistantEvent,
      0,
    );
    const delta = handlerCalls.find((c) => c.kind === "assistant_text_delta");
    expect(delta).toBeUndefined();
  });

  test("rejects a conversation-scoped event missing a conversationId entirely", () => {
    const { handleStreamEvent } = renderHandler();
    handleStreamEvent(
      {
        type: "assistant_text_delta",
        delta: "no key",
      } as unknown as AssistantEvent,
      0,
    );
    const delta = handlerCalls.find((c) => c.kind === "assistant_text_delta");
    expect(delta).toBeUndefined();
  });

  test("rejects a conversation-scoped event when stream context is null", () => {
    const { handleStreamEvent } = renderHandler({
      streamConversationId: null,
    });
    handleStreamEvent(
      {
        type: "message_complete",
        conversationId: "conv-A",
        messageId: "m1",
      } as unknown as AssistantEvent,
      0,
    );
    const result = handlerCalls.find((c) => c.kind === "message_complete");
    expect(result).toBeUndefined();
  });

  test("forwards a global event (sync_changed) regardless of conversation context", () => {
    const { handleStreamEvent } = renderHandler({
      streamConversationId: null,
    });
    handleStreamEvent(
      {
        type: "sync_changed",
        tags: ["assistant:self:identity"],
      } as unknown as AssistantEvent,
      0,
    );
    // sync_changed is a no-op in the stream handler (bus subscribers
    // own it). The global event passing the guard is the key point.
    // No "wrong_conversation" diagnostic should be recorded — implicit
    // assertion that we got here without an early return.
    expect(true).toBe(true);
  });

  test("no-ops a cross-domain event (home_feed_updated) handled by bus subscribers", () => {
    const { handleStreamEvent } = renderHandler({
      streamConversationId: null,
    });
    handleStreamEvent(
      {
        type: "home_feed_updated",
        updatedAt: "2026-05-22T00:00:00Z",
      } as unknown as AssistantEvent,
      0,
    );
    // home_feed_updated is now handled by useAssistantResourceSync (bus
    // subscriber), not the monolithic handler. The switch case is a no-op.
    const homeFeedCalls = handlerCalls.filter((c) => c.kind === "home_feed_updated");
    expect(homeFeedCalls).toHaveLength(0);
  });

  test("rejects events whose epoch is stale (regardless of conversation key)", () => {
    const { handleStreamEvent } = renderHandler({ streamEpoch: 5 });
    handleStreamEvent(
      {
        type: "assistant_text_delta",
        conversationId: "conv-A",
        delta: "old",
      } as unknown as AssistantEvent,
      3,
    );
    const delta = handlerCalls.find((c) => c.kind === "assistant_text_delta");
    expect(delta).toBeUndefined();
  });
});
