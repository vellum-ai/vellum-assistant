import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import { useFeatureFlagBusSync } from "@/hooks/use-feature-flag-bus-sync";
import { assistantFeatureFlagsGetQueryKey } from "@/generated/gateway/@tanstack/react-query.gen";
import { featureFlagsClientFlagValuesRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import { SYNC_TAGS, type SyncChangedEvent } from "@/lib/sync/types";
import { __resetForTesting, publish } from "@/lib/event-bus";

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function freshQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function syncEvent(tags: string[]): SyncChangedEvent {
  return { type: "sync_changed", tags };
}

function emit(event: SyncChangedEvent): void {
  publish("sse.event", {
    id: "evt-1",
    emittedAt: new Date().toISOString(),
    message: event,
  } as AssistantEventEnvelope);
}

function emitOpened(
  cause: "fresh" | "error" | "watchdog" | "resume",
  assistantId = "asst-1",
): void {
  publish("sse.opened", { assistantId, cause });
}

beforeEach(() => {
  __resetForTesting();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useFeatureFlagBusSync", () => {
  test("does not fire when assistant is not active", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagBusSync("asst-1", false), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.featureFlagsClient]));
    expect(spy).not.toHaveBeenCalled();
  });

  test("invalidates client feature flag query on feature-flags:client sync tag", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagBusSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.featureFlagsClient]));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        {
          queryKey: featureFlagsClientFlagValuesRetrieveQueryKey(),
        },
        { cancelRefetch: false, throwOnError: false },
      );
    });
  });

  test("deduplicates bursty client feature flag invalidations", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagBusSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });

    emit(syncEvent([SYNC_TAGS.featureFlagsClient]));
    emit(syncEvent([SYNC_TAGS.featureFlagsClient]));
    emitOpened("error");
    emitOpened("watchdog");

    await waitFor(() => {
      const clientCalls = (
        spy.mock.calls as unknown as Array<
          [{ queryKey?: readonly unknown[] }, unknown?]
        >
      ).filter(([options]) => {
        const key = options.queryKey?.[0] as { _id?: string } | undefined;
        return key?._id === "featureFlagsClientFlagValuesRetrieve";
      });
      expect(clientCalls).toHaveLength(1);
    });
  });

  test("queues one refresh when invalidation races an active fetch", async () => {
    const queryClient = freshQueryClient();
    let finishActiveFetch: (() => void) | undefined;
    const activeFetch = new Promise<void>((resolve) => {
      finishActiveFetch = resolve;
    });
    let isFetching = true;
    queryClient.isFetching = mock(() => (isFetching ? 1 : 0)) as never;
    const spy = mock(() => (isFetching ? activeFetch : Promise.resolve()));
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagBusSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });

    emit(syncEvent([SYNC_TAGS.featureFlagsClient]));
    emit(syncEvent([SYNC_TAGS.featureFlagsClient]));
    expect(spy).toHaveBeenCalledTimes(1);

    isFetching = false;
    finishActiveFetch?.();

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  test("delays one refresh when an active fetch fails", async () => {
    const queryClient = freshQueryClient();
    let failActiveFetch: ((error: Error) => void) | undefined;
    const activeFetch = new Promise<void>((_, reject) => {
      failActiveFetch = reject;
    });
    let isFetching = true;
    queryClient.isFetching = mock(() => (isFetching ? 1 : 0)) as never;
    const spy = mock(() => (isFetching ? activeFetch : Promise.resolve()));
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagBusSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });

    emit(syncEvent([SYNC_TAGS.featureFlagsClient]));
    expect(spy).toHaveBeenCalledWith(
      {
        queryKey: featureFlagsClientFlagValuesRetrieveQueryKey(),
      },
      { cancelRefetch: false, throwOnError: true },
    );

    isFetching = false;
    const originalSetTimeout = globalThis.setTimeout;
    let scheduledRefresh: (() => void) | undefined;
    let scheduledDelay: number | undefined;
    globalThis.setTimeout = mock((callback: TimerHandler, delay?: number) => {
      if (typeof callback === "function") {
        scheduledRefresh = () => callback();
      }
      scheduledDelay = delay;
      return 1;
    }) as unknown as typeof setTimeout;
    try {
      failActiveFetch?.(new Error("rate limited"));
      await Promise.resolve();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(scheduledDelay).toBe(30_000);

      globalThis.setTimeout = originalSetTimeout;
      scheduledRefresh?.();
      await Promise.resolve();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("invalidates assistant feature flag query prefix on feature-flags:assistant sync tag", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagBusSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.featureFlagsAssistant]));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: assistantFeatureFlagsGetQueryKey({
          path: { assistant_id: "asst-1" },
        }),
      });
    });
  });

  test("invalidates both flag queries on sse.opened reconnect (cause=error)", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagBusSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emitOpened("error");
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        {
          queryKey: featureFlagsClientFlagValuesRetrieveQueryKey(),
        },
        { cancelRefetch: false, throwOnError: false },
      );
      expect(spy).toHaveBeenCalledWith({
        queryKey: assistantFeatureFlagsGetQueryKey({
          path: { assistant_id: "asst-1" },
        }),
      });
    });
  });

  test("invalidates both flag queries on sse.opened (cause=watchdog and cause=resume)", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagBusSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emitOpened("watchdog");
    emitOpened("resume");
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        {
          queryKey: featureFlagsClientFlagValuesRetrieveQueryKey(),
        },
        { cancelRefetch: false, throwOnError: false },
      );
      expect(spy).toHaveBeenCalledWith({
        queryKey: assistantFeatureFlagsGetQueryKey({
          path: { assistant_id: "asst-1" },
        }),
      });
    });
  });

  test("catches up client flags on the initial sse.opened", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagBusSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emitOpened("fresh");
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        {
          queryKey: featureFlagsClientFlagValuesRetrieveQueryKey(),
        },
        { cancelRefetch: false, throwOnError: false },
      );
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
