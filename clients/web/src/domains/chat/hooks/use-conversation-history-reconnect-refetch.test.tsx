import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { __resetForTesting, publish } from "@/lib/event-bus";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useConversationStore } from "@/stores/conversation-store";
import type { DisplayMessage } from "@/domains/chat/types/types";

// ---------------------------------------------------------------------------
// Module mock — `@/domains/chat/transcript/use-history-pagination`.
//
// Stub the TanStack Query layer so the test exercises only the reconnect →
// refetch wiring. `invalidate` is the spy under test; `isSuccess: false`
// keeps the data-apply effect (and its downstream interaction/surface
// fetches) dormant.
// ---------------------------------------------------------------------------
const realPaginationModule = await import(
  "@/domains/chat/transcript/use-history-pagination"
);

let invalidateSpy = mock(async () => {});

function paginationStub(): HistoryPaginationResult {
  return {
    messages: [],
    latestPage: undefined,
    subagentNotifications: undefined,
    isLoading: false,
    isSuccess: false,
    isError: false,
    error: null,
    hasMore: false,
    isFetchingOlderPages: false,
    isFetching: false,
    fetchOlderPage: () => {},
    invalidate: invalidateSpy,
    removeCache: () => {},
    latestPageOldestTimestamp: null,
    oldestLoadedTimestamp: null,
    dataUpdatedAt: 0,
  };
}

mock.module("@/domains/chat/transcript/use-history-pagination", () => ({
  ...realPaginationModule,
  useHistoryPagination: () => paginationStub(),
}));

const { useConversationHistory } = await import(
  "@/domains/chat/hooks/use-conversation-history"
);

// The hook reads `useQueryClient()` (for surface cache writes and the
// live-turn→history handoff), so it must render inside a provider.
const queryClient = new QueryClient();

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderHistory(activeConversationId: string | null = "conv-A") {
  return renderHook(
    () =>
      useConversationHistory({
        assistantId: "asst-1",
        assistantStateKind: "active",
        activeConversationId,
      }),
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  __resetForTesting();
  invalidateSpy = mock(async () => {});
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  useChatSessionStore.getState().setLiveTurn([]);
  useConversationStore.getState().removeProcessingConversationId("conv-A");
});

describe("useConversationHistory — refetch on SSE reopen", () => {
  test("refetches history when the connection reopens after a resume", () => {
    /**
     * A resume reopen (return-from-background) past the daemon's 30s replay
     * ring must refetch `/messages` so an idle conversation's persisted tail
     * appears without a manual refresh.
     */
    // GIVEN an active conversation with a mounted history hook
    renderHistory("conv-A");

    // WHEN the bus reopens its SSE connection with a resume cause
    publish("sse.opened", { assistantId: "asst-1", cause: "resume" });

    // THEN the history query is invalidated to pull the latest snapshot
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  test.each([["error"], ["watchdog"], ["debug"]] as const)(
    "refetches history on a '%s' reconnect",
    (cause) => {
      /**
       * Every non-initial reopen is a catch-up opportunity: the connection
       * was previously established, so the snapshot may have advanced while
       * it was down.
       */
      // GIVEN an active conversation with a mounted history hook
      renderHistory("conv-A");

      // WHEN the bus reopens with a transport-recovery / debug cause
      publish("sse.opened", { assistantId: "asst-1", cause });

      // THEN the history query is invalidated
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
    },
  );

  test("does not refetch on the first 'fresh' open", () => {
    /**
     * The initial connect's `refetchOnMount` already loaded the snapshot, so
     * a fresh open must not trigger a redundant second fetch.
     */
    // GIVEN an active conversation with a mounted history hook
    renderHistory("conv-A");

    // WHEN the bus reports the first fresh open
    publish("sse.opened", { assistantId: "asst-1", cause: "fresh" });

    // THEN no extra history refetch is issued
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("does not refetch on a cold-start 'anchor' reopen", () => {
    /**
     * The anchor bounce fires immediately after the fresh load with the ring
     * still warm, so the ring replay — not a refetch — is the catch-up.
     */
    // GIVEN an active conversation with a mounted history hook
    renderHistory("conv-A");

    // WHEN the bus reopens for the cold-start anchor replay
    publish("sse.opened", { assistantId: "asst-1", cause: "anchor" });

    // THEN no history refetch is issued
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("ignores reopens for a different assistant", () => {
    /**
     * The bus is assistant-global; a reopen for another assistant must not
     * refetch the active assistant's conversation.
     */
    // GIVEN an active conversation for asst-1
    renderHistory("conv-A");

    // WHEN a reopen arrives for a different assistant
    publish("sse.opened", { assistantId: "asst-other", cause: "resume" });

    // THEN the active assistant's history is not refetched
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("does not refetch when there is no active conversation", () => {
    /**
     * With no conversation selected there is nothing to reconcile, so a
     * reopen must be a no-op.
     */
    // GIVEN no active conversation
    renderHistory(null);

    // WHEN the bus reopens after a resume
    publish("sse.opened", { assistantId: "asst-1", cause: "resume" });

    // THEN no history refetch is issued
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("hands a passively-observed turn off to history on processing→idle", () => {
    /**
     * Channel turns (phone, Slack, Telegram) and other-client sends stream in
     * without a local `useSendMessage`, so `turnPhase` never enters a sending
     * state. They still toggle the conversation's processing flag, so the
     * finished turn must be pulled into the durable history cache on that
     * processing→idle edge — otherwise the live view shows only the latest
     * exchange until a reload.
     */
    // GIVEN an active conversation with a live turn, marked processing (a
    // server-driven turn streaming in)
    renderHistory("conv-A");
    act(() => {
      useChatSessionStore
        .getState()
        .setLiveTurn([
          { id: "m1", role: "assistant" } as unknown as DisplayMessage,
        ]);
      useConversationStore.getState().markConversationProcessing("conv-A");
    });
    // No handoff while the turn is still in progress.
    expect(invalidateSpy).not.toHaveBeenCalled();

    // WHEN the turn finishes and the processing flag clears
    act(() => {
      useConversationStore.getState().removeProcessingConversationId("conv-A");
    });

    // THEN the finished turn is handed off to the durable history cache
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  test("does not hand off on processing→idle when the live turn is empty", () => {
    // A processing edge with nothing in the live turn has nothing to hand off,
    // so it must not trigger a redundant refetch.
    renderHistory("conv-A");
    act(() => {
      useConversationStore.getState().markConversationProcessing("conv-A");
    });
    act(() => {
      useConversationStore.getState().removeProcessingConversationId("conv-A");
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
