import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";

// ---------------------------------------------------------------------------
// Module mocks.
//
// `use-history-pagination` is stubbed so the test drives the post-load
// (data-apply) effect directly; `latestPage.processing` carries the daemon's
// authoritative flag under test. The interactions API is stubbed to `{}` so
// the effect's async pending-interaction restore makes no network call — the
// synchronous `seedSnapshot` is all this test asserts on.
// ---------------------------------------------------------------------------
const realPaginationModule = await import(
  "@/domains/chat/transcript/use-history-pagination"
);

let currentProcessing: boolean | undefined;

function latestPageStub(): PaginatedHistoryResult {
  return {
    messages: [],
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
    seq: 10,
    processing: currentProcessing,
    backgroundToolCompletions: [],
  };
}

function paginationStub(): HistoryPaginationResult {
  return {
    messages: [],
    latestPage: latestPageStub(),
    subagentNotifications: undefined,
    backgroundToolCompletions: undefined,
    isLoading: false,
    isSuccess: true,
    isError: false,
    error: null,
    hasMore: false,
    isFetchingOlderPages: false,
    isFetching: false,
    fetchOlderPage: () => {},
    invalidate: async () => {},
    removeCache: () => {},
    latestPageOldestTimestamp: null,
    oldestLoadedTimestamp: null,
    dataUpdatedAt: 1,
  };
}

mock.module("@/domains/chat/transcript/use-history-pagination", () => ({
  ...realPaginationModule,
  useHistoryPagination: () => paginationStub(),
}));

mock.module("@/domains/chat/api/interactions", () => ({
  getPendingInteractions: async () => ({}),
}));

const { useConversationHistory } = await import(
  "@/domains/chat/hooks/use-conversation-history"
);

const queryClient = new QueryClient();

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderHistory() {
  return renderHook(
    () =>
      useConversationHistory({
        assistantId: "asst-1",
        assistantStateKind: "active",
        activeConversationId: "conv-A",
      }),
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  currentProcessing = undefined;
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
});

afterEach(() => {
  cleanup();
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
});

describe("useConversationHistory — seed carries the authoritative processing flag", () => {
  test("plants processing:false from the fetched page onto the snapshot", () => {
    /**
     * The `snapshotProcessing === false` close-gate and the stream reducer
     * (`nextProcessingState`) can only work from a defined flag, and only the
     * seed can plant one — a snapshot seeded without it is pinned to the
     * `undefined` sentinel for its whole life, leaving a stuck "Thinking…"
     * indicator unrecoverable without a page refresh.
     */
    currentProcessing = false;

    renderHistory();

    expect(useChatSessionStore.getState().snapshot?.processing).toBe(false);
  });

  test("plants processing:true so a later terminal fold can clear it", () => {
    currentProcessing = true;

    renderHistory();

    expect(useChatSessionStore.getState().snapshot?.processing).toBe(true);
  });

  test("keeps the undefined sentinel for pages from older daemons", () => {
    currentProcessing = undefined;

    renderHistory();

    const snapshot = useChatSessionStore.getState().snapshot;
    expect(snapshot).not.toBeNull();
    expect(snapshot?.processing).toBeUndefined();
  });
});
