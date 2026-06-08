import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import { useFeatureFlagBusSync } from "@/hooks/use-feature-flag-bus-sync";
import {
  assistantFlagValuesQueryKey,
  CLIENT_FLAG_QUERY_KEY,
} from "@/lib/sync/query-tags";
import { SYNC_TAGS, type SyncChangedEvent } from "@/lib/sync/types";
import {
  __resetForTesting,
  publish,
} from "@/lib/event-bus";

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
      expect(spy).toHaveBeenCalledWith({
        queryKey: CLIENT_FLAG_QUERY_KEY,
      });
    });
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
        queryKey: assistantFlagValuesQueryKey("asst-1"),
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
      expect(spy).toHaveBeenCalledWith({ queryKey: CLIENT_FLAG_QUERY_KEY });
      expect(spy).toHaveBeenCalledWith({
        queryKey: assistantFlagValuesQueryKey("asst-1"),
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
      expect(spy).toHaveBeenCalledWith({ queryKey: CLIENT_FLAG_QUERY_KEY });
      expect(spy).toHaveBeenCalledWith({
        queryKey: assistantFlagValuesQueryKey("asst-1"),
      });
    });
  });

  test("does NOT invalidate on sse.opened (cause=fresh)", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagBusSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emitOpened("fresh");
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });
});
