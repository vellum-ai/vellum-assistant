import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { __setResumeGraceMsForTesting } from "@/hooks/use-resume-grace";
import { __resetForTesting, publish } from "@/lib/event-bus";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";

// Stub the TanStack Query layer so the test drives the initial-page error
// state directly. `isSuccess: false` marks it as an initial-page (not
// older-page) failure and keeps the data-apply effect dormant.
const realPaginationModule = await import(
  "@/domains/chat/transcript/use-history-pagination"
);

let paginationIsError = false;

function paginationStub(): HistoryPaginationResult {
  return {
    messages: [],
    latestPage: undefined,
    subagentNotifications: undefined,
    backgroundToolCompletions: undefined,
    isLoading: false,
    isSuccess: false,
    isError: paginationIsError,
    error: paginationIsError ? new Error("probe failed") : null,
    hasMore: false,
    isFetchingOlderPages: false,
    isFetching: false,
    fetchOlderPage: () => {},
    invalidate: async () => {},
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

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

const { useConversationHistory } = await import(
  "@/domains/chat/hooks/use-conversation-history"
);

const DEFAULT_RESUME_GRACE_MS = 15_000;
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

function currentError() {
  return useChatSessionStore.getState().error;
}

beforeEach(() => {
  __resetForTesting();
  __setResumeGraceMsForTesting(DEFAULT_RESUME_GRACE_MS);
  paginationIsError = false;
  useChatSessionStore.getState().setError(null);
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  __setResumeGraceMsForTesting(DEFAULT_RESUME_GRACE_MS);
  useChatSessionStore.getState().setError(null);
});

describe("useConversationHistory resume grace on history errors", () => {
  test("holds back the initial-page error within the resume grace window", () => {
    // GIVEN a mounted history hook for an active conversation
    const { rerender } = renderHistory();

    // AND the app has just resumed from the background
    act(() => {
      publish("app.resume", { signal: "visibility" });
    });

    // WHEN the initial history page errors transiently
    paginationIsError = true;
    rerender();

    // THEN no blocking history error is surfaced
    expect(currentError()).toBeNull();
  });

  test("surfaces the initial-page error once the resume grace window expires", async () => {
    // GIVEN a very short resume grace window
    __setResumeGraceMsForTesting(20);

    // AND a mounted history hook that just resumed from the background
    const { rerender } = renderHistory();
    act(() => {
      publish("app.resume", { signal: "visibility" });
    });

    // WHEN the initial history page error persists past the window
    paginationIsError = true;
    rerender();

    // THEN the blocking history error surfaces
    await waitFor(() => {
      expect(currentError()?.message).toBe(
        "Failed to load conversation history. Please try again.",
      );
    });
  });

  test("surfaces the initial-page error immediately without a resume", () => {
    // GIVEN a mounted history hook with no resume signal
    const { rerender } = renderHistory();

    // WHEN the initial history page errors
    paginationIsError = true;
    rerender();

    // THEN the blocking history error surfaces right away
    expect(currentError()?.message).toBe(
      "Failed to load conversation history. Please try again.",
    );
  });
});
