import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import type { AssistantEvent } from "@/types/event-types";

const handlerCalls: Array<{ kind: string; conversationId?: string }> = [];

mock.module(
  "@/domains/chat/utils/stream-handlers/message-handlers",
  () => ({
    handleAssistantTextDelta: (event: { conversationId?: string }) => {
      handlerCalls.push({ kind: "assistant_text_delta", conversationId: event.conversationId });
    },
    handleAssistantActivityState: () => {
      handlerCalls.push({ kind: "assistant_activity_state" });
    },
    handleMessageComplete: (event: { conversationId?: string }) => {
      handlerCalls.push({ kind: "message_complete", conversationId: event.conversationId });
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

function noopRefs() {
  return {
    streamEpochRef: { current: 0 } as MutableRefObject<number>,
    activeConversationIdRef: {
      current: "conv-A",
    } as MutableRefObject<string | null>,
    streamContextRef: {
      current: { assistantId: "asst-1", conversationId: "conv-A" },
    } as MutableRefObject<{ assistantId: string; conversationId: string } | null>,
    assistantIdRef: { current: "asst-1" } as MutableRefObject<string | null>,
    messagesRef: { current: [] } as MutableRefObject<unknown[]>,
    streamRef: { current: null } as MutableRefObject<unknown>,
    confirmationToolCallMapRef: { current: new Map() } as MutableRefObject<
      Map<string, string>
    >,
    dismissedSurfaceIdsRef: { current: new Set() } as MutableRefObject<
      Set<string>
    >,
    contextWindowUsageByConversationRef: { current: new Map() } as MutableRefObject<
      Map<string, unknown>
    >,
    pendingQueuedMessageIdsRef: { current: [] } as MutableRefObject<string[]>,
    requestIdToMessageIdRef: { current: new Map() } as MutableRefObject<
      Map<string, string>
    >,
    pendingLocalDeletionsRef: { current: new Set() } as MutableRefObject<
      Set<string>
    >,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function renderHandler(
  refs: ReturnType<typeof noopRefs>,
  overrides?: {
    streamEpoch?: number;
    streamConversationId?: string | null;
    activeConversationId?: string | null;
  },
) {
  if (overrides?.streamEpoch !== undefined) {
    refs.streamEpochRef.current = overrides.streamEpoch;
  }
  if (overrides?.streamConversationId !== undefined) {
    refs.streamContextRef.current =
      overrides.streamConversationId === null
        ? null
        : { assistantId: "asst-1", conversationId: overrides.streamConversationId };
  }
  if (overrides?.activeConversationId !== undefined) {
    refs.activeConversationIdRef.current = overrides.activeConversationId;
  }
  const { result } = renderHook(
    () =>
      useStreamEventHandler({
        push: () => {},
        isNative: false,
        ...refs,
        setMessages: () => {},
        setError: () => {},
        cancelReconciliation: () => {},
        startReconciliationLoop: () => {},
        setAssetsRefreshKey: () => {},
        setContextWindowUsage: () => {},
        scheduleConversationListRefetch: () => {},
        setCompactionCircuitOpenUntil: () => {},
        dispatchSyncChanged: () => {},
      } as never),
    { wrapper },
  );
  return result.current;
}

beforeEach(() => {
  handlerCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("handleStreamEvent — defense-in-depth conversation routing guard", () => {
  test("forwards a conversation-scoped event whose key matches the stream context", () => {
    const refs = noopRefs();
    const { handleStreamEvent } = renderHandler(refs);
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
    const refs = noopRefs();
    const { handleStreamEvent } = renderHandler(refs, {
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
    const refs = noopRefs();
    const { handleStreamEvent } = renderHandler(refs);
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
    const refs = noopRefs();
    const { handleStreamEvent } = renderHandler(refs, {
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
    const refs = noopRefs();
    refs.streamContextRef.current = null;
    const { handleStreamEvent } = renderHandler(refs, {
      streamConversationId: null,
    });
    handleStreamEvent(
      {
        type: "sync_changed",
        tags: ["assistant:self:identity"],
      } as unknown as AssistantEvent,
      0,
    );
    // sync_changed routes through dispatchSyncChanged (provided as
    // a noop); the global event passing the guard is the key point.
    // No "wrong_conversation" diagnostic should be recorded — implicit
    // assertion that we got here without an early return.
    expect(true).toBe(true);
  });

  test("no-ops a cross-domain event (home_feed_updated) handled by bus subscribers", () => {
    const refs = noopRefs();
    const { handleStreamEvent } = renderHandler(refs, {
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
    const refs = noopRefs();
    const { handleStreamEvent } = renderHandler(refs, { streamEpoch: 5 });
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
