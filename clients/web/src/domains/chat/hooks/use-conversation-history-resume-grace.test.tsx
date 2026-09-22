import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  __setResumeGraceMsForTesting,
  useResumeGrace,
} from "@/hooks/use-resume-grace";
import { __resetForTesting, publish } from "@/lib/event-bus";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";

const realHistoryApi = await import("@/domains/chat/api/history");
const fetchLatestHistoryPage = mock(
  async (): Promise<PaginatedHistoryResult> => page(),
);
const fetchOlderHistoryPage = mock(
  async (): Promise<PaginatedHistoryResult> => page(),
);

mock.module("@/domains/chat/api/history", () => ({
  ...realHistoryApi,
  fetchLatestHistoryPage,
  fetchOlderHistoryPage,
}));

mock.module("@/domains/chat/api/interactions", () => ({
  getPendingInteractions: async () => ({}),
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

const { useConversationHistory } = await import(
  "@/domains/chat/hooks/use-conversation-history"
);

const DEFAULT_RESUME_GRACE_MS = 15_000;
const HISTORY_ERROR = "Failed to load conversation history. Please try again.";
let queryClient: QueryClient;

function page(empty = false): PaginatedHistoryResult {
  return {
    messages: empty ? [] : [{ id: "msg-1", role: "user", textSegments: ["Hello"] }],
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderHistory() {
  return renderHook(
    () => ({
      ...useConversationHistory({
        assistantId: "asst-1",
        assistantStateKind: "active",
        activeConversationId: "conv-A",
      }),
      isResumeGraceActive: useResumeGrace(),
    }),
    { wrapper: Wrapper },
  );
}

function currentError() {
  return useChatSessionStore.getState().error;
}

function failLatestFetch() {
  fetchLatestHistoryPage.mockImplementation(async () => {
    throw new TypeError("Failed to fetch");
  });
}

function resume() {
  act(() => {
    publish("app.hidden", { signal: "app_state" });
    publish("app.resume", { signal: "app_state" });
    publish("sse.opened", { assistantId: "asst-1", cause: "resume" });
  });
}

beforeEach(() => {
  __resetForTesting();
  __setResumeGraceMsForTesting(DEFAULT_RESUME_GRACE_MS);
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  fetchLatestHistoryPage.mockReset();
  fetchLatestHistoryPage.mockImplementation(async () => page());
  fetchOlderHistoryPage.mockReset();
  fetchOlderHistoryPage.mockImplementation(async () => page());
  useChatSessionStore.setState({ error: null, snapshot: null, optimisticSends: [] });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  __resetForTesting();
  __setResumeGraceMsForTesting(DEFAULT_RESUME_GRACE_MS);
  useChatSessionStore.setState({ error: null, snapshot: null, optimisticSends: [] });
});

describe("useConversationHistory resume and fetch errors", () => {
  test("holds back an initial-page error within the resume grace window", async () => {
    failLatestFetch();
    const { result } = renderHistory();
    resume();

    await waitFor(() => expect(result.current.pagination.isError).toBe(true));
    expect(result.current.isResumeGraceActive).toBe(true);
    expect(currentError()).toBeNull();
  });

  test("surfaces an initial-page error once the resume grace window expires", async () => {
    __setResumeGraceMsForTesting(20);
    failLatestFetch();
    renderHistory();
    resume();

    await waitFor(() => expect(currentError()?.message).toBe(HISTORY_ERROR));
  });

  test("surfaces an initial-page error without a resume", async () => {
    failLatestFetch();
    renderHistory();

    await waitFor(() => expect(currentError()?.message).toBe(HISTORY_ERROR));
  });

  test.each([false, true])(
    "keeps cached history usable after resume grace expires (empty: %s)",
    async (empty) => {
      __setResumeGraceMsForTesting(20);
      fetchLatestHistoryPage.mockImplementation(async () => page(empty));
      const { result } = renderHistory();
      await waitFor(() => expect(result.current.pagination.isSuccess).toBe(true));
      const snapshot = useChatSessionStore.getState().snapshot;
      expect(snapshot?.messages).toEqual(page(empty).messages);

      failLatestFetch();
      resume();

      await waitFor(() => {
        expect(result.current.pagination.isError).toBe(true);
        expect(result.current.isResumeGraceActive).toBe(false);
      });
      expect(result.current.pagination.isSuccess).toBe(false);
      expect(useChatSessionStore.getState().snapshot).toBe(snapshot);
      expect(currentError()).toBeNull();

      fetchLatestHistoryPage.mockImplementation(async () => ({
        ...page(),
        messages: [{ id: "msg-2", role: "user", textSegments: ["New message"] }],
      }));
      act(() => publish("sse.opened", { assistantId: "asst-1", cause: "error" }));
      await waitFor(() => {
        expect(useChatSessionStore.getState().snapshot?.messages[0]?.id).toBe("msg-2");
      });
      expect(currentError()).toBeNull();
    },
  );

  test("keeps cached history usable when an older-page fetch fails", async () => {
    fetchLatestHistoryPage.mockImplementation(async () => ({
      ...page(),
      hasMore: true,
      oldestTimestamp: 100,
    }));
    fetchOlderHistoryPage.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { result } = renderHistory();
    await waitFor(() => expect(result.current.pagination.isSuccess).toBe(true));
    const snapshot = useChatSessionStore.getState().snapshot;

    act(() => result.current.pagination.fetchOlderPage());
    await waitFor(() => expect(result.current.pagination.isError).toBe(true));

    expect(useChatSessionStore.getState().snapshot).toBe(snapshot);
    expect(currentError()).toBeNull();
  });

  test("clears a history error after a successful retry", async () => {
    failLatestFetch();
    const { result } = renderHistory();
    await waitFor(() => expect(currentError()?.message).toBe(HISTORY_ERROR));

    fetchLatestHistoryPage.mockImplementation(async () => page());
    await act(() => result.current.pagination.invalidate());
    await waitFor(() => expect(result.current.pagination.isSuccess).toBe(true));

    expect(currentError()).toBeNull();
  });

  test("holds back a pre-resume history error while reconnecting", async () => {
    failLatestFetch();
    renderHistory();
    await waitFor(() => expect(currentError()?.message).toBe(HISTORY_ERROR));

    resume();

    expect(currentError()).toBeNull();
  });

  test("preserves a newer send error when history recovers", async () => {
    failLatestFetch();
    const { result } = renderHistory();
    await waitFor(() => expect(currentError()?.message).toBe(HISTORY_ERROR));
    const sendError = { message: "Message could not be sent" };
    act(() => useChatSessionStore.getState().setError(sendError));

    fetchLatestHistoryPage.mockImplementation(async () => page());
    await act(() => result.current.pagination.invalidate());
    await waitFor(() => expect(result.current.pagination.isSuccess).toBe(true));

    expect(currentError()).toBe(sendError);
  });
});
