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
import { ApiError } from "@/utils/api-errors";
import type { OrgHeaderReadiness } from "@/hooks/use-is-org-ready";

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

let podIsServing = true;
const realOperationalStatus = await import("@/assistant/operational-status");
mock.module("@/assistant/operational-status", () => ({
  ...realOperationalStatus,
  useAssistantIsServing: () => podIsServing,
}));

let orgReadiness: OrgHeaderReadiness = "ready";
const realOrgReady = await import("@/hooks/use-is-org-ready");
mock.module("@/hooks/use-is-org-ready", () => ({
  ...realOrgReady,
  useOrgHeaderReadiness: () => orgReadiness,
  useIsOrgReady: () => orgReadiness === "ready",
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
  podIsServing = true;
  orgReadiness = "ready";
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

/**
 * The daemon 503s every request while its pod wakes, and the assistant record
 * reads `active` throughout, so only the operational-status gate knows to hold
 * the history query. A failure from that window is the wake, not a failed load.
 */
describe("useConversationHistory while the assistant is waking", () => {
  function useInstantRetries() {
    queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: 0, retryDelay: 0 } },
    });
  }

  function isLoadingHistory() {
    return useChatSessionStore.getState().isLoadingHistory;
  }

  test("holds the fetch and shows loading, not an error", async () => {
    podIsServing = false;
    const { result } = renderHistory();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(fetchLatestHistoryPage).not.toHaveBeenCalled();
    expect(result.current.pagination.daemonGate).toBe("waiting");
    expect(currentError()).toBeNull();
    expect(isLoadingHistory()).toBe(true);
  });

  test("loads history once the pod is serving", async () => {
    podIsServing = false;
    const { result, rerender } = renderHistory();
    expect(fetchLatestHistoryPage).not.toHaveBeenCalled();

    podIsServing = true;
    rerender();

    await waitFor(() => expect(result.current.pagination.isSuccess).toBe(true));
    expect(fetchLatestHistoryPage).toHaveBeenCalledTimes(1);
    expect(useChatSessionStore.getState().snapshot?.messages).toEqual(
      page().messages,
    );
    expect(currentError()).toBeNull();
  });

  test("surfaces a failure that lands after the pod is serving", async () => {
    useInstantRetries();
    fetchLatestHistoryPage.mockImplementation(async () => {
      throw new ApiError(503, "Service Unavailable");
    });
    podIsServing = false;
    const { rerender } = renderHistory();

    podIsServing = true;
    rerender();

    await waitFor(() => expect(currentError()?.message).toBe(HISTORY_ERROR));
  });

  test("holds a failure whose retries run out after the pod stops serving", async () => {
    // Disabling a query does not stop a retry loop already in flight, so a
    // fetch issued before the gate closed still settles as an error behind
    // it. Reopening the gate refetches.
    useInstantRetries();
    let failFirstFetch: () => void = () => {};
    fetchLatestHistoryPage.mockImplementationOnce(
      () =>
        new Promise<PaginatedHistoryResult>((_, reject) => {
          failFirstFetch = () =>
            reject(new ApiError(503, "Service Unavailable"));
        }),
    );
    fetchLatestHistoryPage.mockImplementation(async () => {
      throw new ApiError(503, "Service Unavailable");
    });
    const { result, rerender } = renderHistory();
    await waitFor(() =>
      expect(fetchLatestHistoryPage).toHaveBeenCalledTimes(1),
    );

    podIsServing = false;
    rerender();
    act(() => failFirstFetch());

    await waitFor(() => expect(result.current.pagination.isError).toBe(true));
    expect(fetchLatestHistoryPage).toHaveBeenCalledTimes(4);
    expect(currentError()).toBeNull();
    expect(isLoadingHistory()).toBe(true);

    fetchLatestHistoryPage.mockImplementation(async () => page());
    podIsServing = true;
    rerender();

    await waitFor(() => expect(result.current.pagination.isSuccess).toBe(true));
    expect(fetchLatestHistoryPage).toHaveBeenCalledTimes(5);
    expect(currentError()).toBeNull();
  });

  test("withdraws a raised error when the pod stops serving", async () => {
    failLatestFetch();
    const { result, rerender } = renderHistory();
    await waitFor(() => expect(currentError()?.message).toBe(HISTORY_ERROR));
    expect(isLoadingHistory()).toBe(false);

    podIsServing = false;
    rerender();

    expect(currentError()).toBeNull();
    expect(isLoadingHistory()).toBe(true);

    fetchLatestHistoryPage.mockImplementation(async () => page());
    podIsServing = true;
    rerender();

    await waitFor(() => expect(result.current.pagination.isSuccess).toBe(true));
    expect(currentError()).toBeNull();
    expect(isLoadingHistory()).toBe(false);
  });

  test("does not fetch older pages while the pod is not serving", async () => {
    fetchLatestHistoryPage.mockImplementation(async () => ({
      ...page(),
      hasMore: true,
      oldestTimestamp: 1_000,
    }));
    const { result, rerender } = renderHistory();
    await waitFor(() => expect(result.current.pagination.hasMore).toBe(true));

    podIsServing = false;
    rerender();
    act(() => result.current.pagination.fetchOlderPage());

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fetchOlderHistoryPage).not.toHaveBeenCalled();
  });

  test("fails the initial load when org resolution is unavailable", async () => {
    orgReadiness = "unavailable";
    const { result } = renderHistory();

    await waitFor(() => expect(currentError()?.message).toBe(HISTORY_ERROR));
    expect(result.current.pagination.daemonGate).toBe("unavailable");
    expect(fetchLatestHistoryPage).not.toHaveBeenCalled();
    expect(isLoadingHistory()).toBe(false);
  });
});
