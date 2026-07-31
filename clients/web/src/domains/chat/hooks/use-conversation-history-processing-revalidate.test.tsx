/**
 * Tests for the server-processing revalidation in `useConversationHistory`.
 *
 * `isAssistantBusy` treats the daemon's snapshot `processing: true` as
 * authoritative, so when nothing local agrees with it (idle phase, conversation
 * not flagged processing) that flag alone renders the busy affordances and no
 * local signal is left to fall. This timer is the only exit from that state.
 *
 * bun:test ships no fake-timer API, so `setInterval` is stubbed to capture the
 * armed timer and its delay instead of waiting one out.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { INITIAL_TURN_STATE, useTurnStore } from "@/domains/chat/turn-store";
import { useConversationStore } from "@/stores/conversation-store";

const realPaginationModule = await import(
  "@/domains/chat/transcript/use-history-pagination"
);

let currentProcessing: boolean | undefined;
let invalidateCalls = 0;

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
    invalidate: async () => {
      invalidateCalls += 1;
    },
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

const { SERVER_PROCESSING_REVALIDATE_MS, useConversationHistory } =
  await import("@/domains/chat/hooks/use-conversation-history");

// --- setInterval capture ----------------------------------------------------

interface ArmedTimer {
  handler: () => void;
  delay: number;
  cleared: boolean;
}

let armedTimers: ArmedTimer[] = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

function revalidateTimers(): ArmedTimer[] {
  return armedTimers.filter(
    (timer) => timer.delay === SERVER_PROCESSING_REVALIDATE_MS,
  );
}

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
  invalidateCalls = 0;
  armedTimers = [];
  useTurnStore.setState({ ...INITIAL_TURN_STATE });
  useConversationStore.setState({ processingConversationIds: new Set() });
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });

  globalThis.setInterval = ((handler: () => void, delay: number) => {
    const timer: ArmedTimer = { handler, delay, cleared: false };
    armedTimers.push(timer);
    return armedTimers.length as unknown as ReturnType<typeof setInterval>;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id: number) => {
    const timer = armedTimers[id - 1];
    if (timer) {
      timer.cleared = true;
    }
  }) as typeof globalThis.clearInterval;
});

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  cleanup();
  useTurnStore.setState({ ...INITIAL_TURN_STATE });
  useConversationStore.setState({ processingConversationIds: new Set() });
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
});

describe("useConversationHistory: server-processing revalidation", () => {
  test("polls while the daemon flag is the only thing holding the UI busy", () => {
    currentProcessing = true;

    renderHistory();

    const timers = revalidateTimers();
    expect(timers.length).toBe(1);

    act(() => {
      timers[0]?.handler();
    });
    expect(invalidateCalls).toBe(1);
  });

  test("stops polling once a local turn takes over the busy state", () => {
    // The turn store is reset by the conversation switch this hook performs,
    // so the local turn has to start after the first render.
    currentProcessing = true;

    renderHistory();
    expect(revalidateTimers().length).toBe(1);

    act(() => {
      useTurnStore.getState().requestSend("turn-1");
    });

    expect(revalidateTimers().every((timer) => timer.cleared)).toBe(true);
  });

  test("stops polling while the conversation is flagged processing", () => {
    // The falling edge of `processingConversationIds` already reseeds, so a
    // passively-observed external-channel turn needs no timer.
    currentProcessing = true;

    renderHistory();
    expect(revalidateTimers().length).toBe(1);

    act(() => {
      useConversationStore.setState({
        processingConversationIds: new Set(["conv-A"]),
      });
    });

    expect(revalidateTimers().every((timer) => timer.cleared)).toBe(true);
  });

  test("does not poll once the daemon reports the conversation idle", () => {
    currentProcessing = false;

    renderHistory();

    expect(revalidateTimers().length).toBe(0);
  });

  test("stops polling as soon as a reseed reports the conversation idle", () => {
    currentProcessing = true;

    renderHistory();
    expect(revalidateTimers().length).toBe(1);

    act(() => {
      useChatSessionStore.setState((state) => ({
        snapshot: state.snapshot
          ? { ...state.snapshot, processing: false }
          : state.snapshot,
      }));
    });

    expect(revalidateTimers()[0]?.cleared).toBe(true);
    expect(revalidateTimers().length).toBe(1);
  });
});
