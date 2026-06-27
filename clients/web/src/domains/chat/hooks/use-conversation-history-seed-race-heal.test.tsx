import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { __resetForTesting } from "@/lib/event-bus";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import type { DisplayMessage } from "@/domains/chat/types/types";

// ---------------------------------------------------------------------------
// Stub the pagination layer so only the seed-race heal effect is exercised.
// `isSuccess: false` keeps the snapshot-apply effect dormant; `dataUpdatedAt`
// is driven by a mutable so a test can simulate a fresh snapshot landing
// (the heal effect's trigger) on a rerender.
// ---------------------------------------------------------------------------
const realPaginationModule = await import(
  "@/domains/chat/transcript/use-history-pagination"
);

let dataUpdatedAt = 1;

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
    invalidate: async () => {},
    removeCache: () => {},
    latestPageOldestTimestamp: null,
    oldestLoadedTimestamp: null,
    dataUpdatedAt,
  };
}

mock.module("@/domains/chat/transcript/use-history-pagination", () => ({
  ...realPaginationModule,
  useHistoryPagination: () => paginationStub(),
}));

const { useConversationHistory } = await import(
  "@/domains/chat/hooks/use-conversation-history"
);
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);
const { conversationHistoryQueryKey } = realPaginationModule;

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-A";

let queryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function row(overrides: Partial<DisplayMessage> & { id: string }): DisplayMessage {
  return { role: "assistant", ...overrides } as DisplayMessage;
}

function seedHistory(messages: DisplayMessage[]) {
  queryClient.setQueryData(
    conversationHistoryQueryKey(ASSISTANT_ID, CONVERSATION_ID),
    { pages: [{ messages }], pageParams: [null] },
  );
}

function renderHistory() {
  return renderHook(
    () =>
      useConversationHistory({
        assistantId: ASSISTANT_ID,
        assistantStateKind: "active",
        activeConversationId: CONVERSATION_ID,
      }),
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  __resetForTesting();
  dataUpdatedAt = 1;
  queryClient = new QueryClient();
  useChatSessionStore.getState().setLiveTurn([]);
});

afterEach(() => {
  cleanup();
  useChatSessionStore.getState().setLiveTurn([]);
  __resetForTesting();
});

describe("useConversationHistory — seed-race heal", () => {
  test("drops a prefix-less re-attach shadow when a fresh snapshot lands", () => {
    // GIVEN a mounted hook (the conversation-switch reset has already run)...
    const { rerender } = renderHistory();

    // ...then a prefix-less live bubble opened under the streamed call's id
    // `call-2`, and a snapshot landing with the rich turn anchored on `call-1`
    // that folded `call-2` in as an alias.
    seedHistory([
      row({ id: "u1", role: "user" }),
      row({ id: "call-1", mergedMessageIds: ["call-2"] }),
    ]);
    act(() => {
      useChatSessionStore.getState().setLiveTurn([row({ id: "call-2" })]);
    });

    // WHEN the fresh snapshot bumps dataUpdatedAt (heal effect trigger)
    dataUpdatedAt = 2;
    act(() => rerender());

    // THEN the shadow is pruned so the authoritative history row renders
    expect(useChatSessionStore.getState().liveTurn).toEqual([]);
  });

  test("leaves a seeded live row that carries the history row's id", () => {
    // GIVEN a mounted hook...
    const { rerender } = renderHistory();

    // ...the normal case: history row `a1` and the live row IS that row.
    seedHistory([row({ id: "a1" })]);
    const live = [row({ id: "a1" })];
    act(() => {
      useChatSessionStore.getState().setLiveTurn(live);
    });

    // WHEN a fresh snapshot lands
    dataUpdatedAt = 2;
    act(() => rerender());

    // THEN the live row is untouched — it legitimately wins on content
    expect(useChatSessionStore.getState().liveTurn).toBe(live);
  });
});
