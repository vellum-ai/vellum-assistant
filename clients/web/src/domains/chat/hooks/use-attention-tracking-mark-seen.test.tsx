/**
 * Mark-seen effect: marks the active conversation as seen when opened,
 * and re-marks it when a new assistant message arrives while the user
 * is viewing it (Part 6 of the LUM-1907 attention-sync fix).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import * as sdkGen from "@/generated/daemon/sdk.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { __resetForTesting } from "@/lib/event-bus";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Configurable conversations list returned by useConversationListQuery.
let conversationsImpl: Array<{
  conversationId: string;
  hasUnseenLatestAssistantMessage: boolean;
  [key: string]: unknown;
}> = [];

const markConversationSeenCalls: Array<{
  assistantId: string;
  conversationId: string;
}> = [];
let markConversationSeenImpl: () => Promise<void> = async () => {};

mock.module("@/hooks/conversation-queries", () => ({
  useConversationListQuery: () => ({ conversations: conversationsImpl }),
  useBackgroundConversationListQuery: () => ({ conversations: [] }),
  useScheduledConversationListQuery: () => ({ conversations: [] }),
}));

mock.module("@/utils/conversation-cache-mutations", () => ({
  markConversationSeenLocal: () => {},
  refreshConversationRow: async () => {},
  prependConversation: () => {},
  removeConversation: () => {},
  resolveDraftKey: () => {},
}));

mock.module("@/utils/conversation-cache", () => ({
  getConversations: () => conversationsImpl,
  findConversation: () => undefined,
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  conversationsSeenPost: (opts: { path: { assistant_id: string }; body: { conversationId: string } }) => {
    markConversationSeenCalls.push({ assistantId: opts.path.assistant_id, conversationId: opts.body.conversationId });
    return markConversationSeenImpl().then(() => ({ data: undefined, error: undefined, response: { ok: true } }));
  },
}));

mock.module("@/domains/chat/api/interactions", () => ({
  listConversationIdsWithPendingInteractions: async () => new Set<string>(),
}));

const { useAttentionTracking } = await import(
  "@/domains/chat/hooks/use-attention-tracking"
);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  __resetForTesting();
  useConversationStore.getState().reset();
  conversationsImpl = [];
  markConversationSeenCalls.length = 0;
  markConversationSeenImpl = async () => {};
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  useConversationStore.getState().reset();
});

describe("useAttentionTracking — mark-seen effect", () => {
  test("marks the active conversation as seen when it has unseen messages", async () => {
    conversationsImpl = [
      { conversationId: "conv-1", hasUnseenLatestAssistantMessage: true },
    ];
    act(() => {
      useConversationStore.getState().setActiveConversationId("conv-1");
    });

    renderHook(
      () =>
        useAttentionTracking({
          assistantId: "asst-1",
          assistantStateKind: "active",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(markConversationSeenCalls).toEqual([
        { assistantId: "asst-1", conversationId: "conv-1" },
      ]);
    });
  });

  test("does not mark when conversation has no unseen messages", async () => {
    conversationsImpl = [
      { conversationId: "conv-1", hasUnseenLatestAssistantMessage: false },
    ];
    act(() => {
      useConversationStore.getState().setActiveConversationId("conv-1");
    });

    renderHook(
      () =>
        useAttentionTracking({
          assistantId: "asst-1",
          assistantStateKind: "active",
        }),
      { wrapper },
    );

    // Yield microtasks to allow any async effects to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(markConversationSeenCalls).toHaveLength(0);
  });

  test("re-marks active conversation when hasUnseen flips back to true (Part 6)", async () => {
    // Start with an unseen conversation — the first mark-seen fires.
    conversationsImpl = [
      { conversationId: "conv-1", hasUnseenLatestAssistantMessage: true },
    ];
    act(() => {
      useConversationStore.getState().setActiveConversationId("conv-1");
    });

    const { rerender } = renderHook(
      () =>
        useAttentionTracking({
          assistantId: "asst-1",
          assistantStateKind: "active",
        }),
      { wrapper },
    );

    // Wait for the first mark-seen to fire.
    await waitFor(() => {
      expect(markConversationSeenCalls).toHaveLength(1);
    });

    // Simulate: mark succeeds, cache updated to seen (ref resets to null).
    conversationsImpl = [
      { conversationId: "conv-1", hasUnseenLatestAssistantMessage: false },
    ];
    rerender();

    // Now simulate: new assistant message arrives via metadata sync tag,
    // refreshConversationRow updates cache → hasUnseen flips back to true.
    conversationsImpl = [
      { conversationId: "conv-1", hasUnseenLatestAssistantMessage: true },
    ];
    rerender();

    // The effect should re-fire mark-seen for the same conversation.
    await waitFor(() => {
      expect(markConversationSeenCalls).toHaveLength(2);
      expect(markConversationSeenCalls[1]).toEqual({
        assistantId: "asst-1",
        conversationId: "conv-1",
      });
    });
  });

  test("resets ref on API failure so the next open retries", async () => {
    // Simulate: mark-seen API fails → user navigates away → navigates back.
    // The ref must reset on failure so the retry can fire.
    let callCount = 0;
    markConversationSeenImpl = async () => {
      callCount++;
      if (callCount === 1) throw new Error("429 rate limited");
    };

    conversationsImpl = [
      { conversationId: "conv-1", hasUnseenLatestAssistantMessage: true },
    ];
    act(() => {
      useConversationStore.getState().setActiveConversationId("conv-1");
    });

    const { rerender } = renderHook(
      () =>
        useAttentionTracking({
          assistantId: "asst-1",
          assistantStateKind: "active",
        }),
      { wrapper },
    );

    // First call fires and fails.
    await waitFor(() => {
      expect(markConversationSeenCalls).toHaveLength(1);
    });

    // Simulate navigating away (different conversation or no conversation).
    conversationsImpl = [
      { conversationId: "conv-1", hasUnseenLatestAssistantMessage: true },
      { conversationId: "conv-2", hasUnseenLatestAssistantMessage: false },
    ];
    act(() => {
      useConversationStore.getState().setActiveConversationId("conv-2");
    });
    rerender();
    await Promise.resolve();

    // Navigate back to the original unread conversation.
    act(() => {
      useConversationStore.getState().setActiveConversationId("conv-1");
    });
    rerender();

    // The ref was reset on failure, so a retry fires.
    await waitFor(() => {
      expect(markConversationSeenCalls).toHaveLength(2);
      expect(markConversationSeenCalls[1]).toEqual({
        assistantId: "asst-1",
        conversationId: "conv-1",
      });
    });
  });

  test("does not fire concurrent mark-seen calls for the same conversation", async () => {
    // Use a deferred promise so we control when the first mark resolves.
    let resolveFirst: (() => void) | null = null;
    markConversationSeenImpl = () =>
      new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

    conversationsImpl = [
      { conversationId: "conv-1", hasUnseenLatestAssistantMessage: true },
    ];
    act(() => {
      useConversationStore.getState().setActiveConversationId("conv-1");
    });

    const { rerender } = renderHook(
      () =>
        useAttentionTracking({
          assistantId: "asst-1",
          assistantStateKind: "active",
        }),
      { wrapper },
    );

    // Wait for first call to fire.
    await waitFor(() => {
      expect(markConversationSeenCalls).toHaveLength(1);
    });

    // While first call is in-flight, simulate another hasUnseen flip.
    // The ref guard should prevent a second call.
    conversationsImpl = [
      { conversationId: "conv-1", hasUnseenLatestAssistantMessage: true },
    ];
    rerender();
    await Promise.resolve();
    await Promise.resolve();

    // Still only 1 call — the ref prevents concurrent marking.
    expect(markConversationSeenCalls).toHaveLength(1);

    // Now resolve the first call and let the ref reset.
    act(() => {
      resolveFirst?.();
    });
    await waitFor(() => {
      // After resolution, the ref resets to null. If hasUnseen is still
      // true, the next render would re-fire. Since we didn't change
      // conversationsImpl, the dep change from the rerender already
      // happened — so no additional call fires automatically.
      expect(markConversationSeenCalls).toHaveLength(1);
    });
  });
});
