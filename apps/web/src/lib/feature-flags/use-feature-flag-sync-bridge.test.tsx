/**
 * Unit tests for `useFeatureFlagSyncBridge`.
 *
 * The bridge is the web-side half of the daemon→web push channel that
 * replaces 5s polling on `useAssistantFeatureFlagSync` and
 * `useClientFeatureFlagSync`. It subscribes to the event bus's
 * `sse.event` channel and, on a `sync_changed` with either of the two
 * feature-flag tags, invalidates the matching React Query cache.
 *
 * @jest-environment happy-dom
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";

import type { AssistantEvent } from "@/domains/chat/api/event-types.js";
import { ASSISTANT_FLAG_VALUES_QUERY_KEY } from "@/lib/feature-flags/use-assistant-feature-flag-sync.js";
import { CLIENT_FLAG_QUERY_KEY } from "@/lib/feature-flags/use-client-feature-flag-sync.js";
import { useFeatureFlagSyncBridge } from "@/lib/feature-flags/use-feature-flag-sync-bridge.js";
import { SYNC_TAGS, type SyncChangedEvent } from "@/lib/sync/types.js";
import {
  __resetEventBusForTesting,
  useEventBusStore,
} from "@/stores/event-bus-store.js";

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

function emit(event: AssistantEvent): void {
  useEventBusStore.getState().publish("sse.event", event);
}

beforeEach(() => {
  __resetEventBusForTesting();
});

afterEach(() => {
  cleanup();
  __resetEventBusForTesting();
});

describe("useFeatureFlagSyncBridge", () => {
  test("invalidates client flag query on feature-flags:client tag", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagSyncBridge(), {
      wrapper: createWrapper(queryClient),
    });

    emit(syncEvent([SYNC_TAGS.featureFlagsClient]));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: CLIENT_FLAG_QUERY_KEY });
  });

  test("invalidates assistant flag query prefix on feature-flags:assistant tag", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagSyncBridge(), {
      wrapper: createWrapper(queryClient),
    });

    emit(syncEvent([SYNC_TAGS.featureFlagsAssistant]));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      queryKey: [ASSISTANT_FLAG_VALUES_QUERY_KEY],
    });
  });

  test("invalidates both queries when both tags fire in one event", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagSyncBridge(), {
      wrapper: createWrapper(queryClient),
    });

    emit(
      syncEvent([
        SYNC_TAGS.featureFlagsClient,
        SYNC_TAGS.featureFlagsAssistant,
      ]),
    );

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith({ queryKey: CLIENT_FLAG_QUERY_KEY });
    expect(spy).toHaveBeenCalledWith({
      queryKey: [ASSISTANT_FLAG_VALUES_QUERY_KEY],
    });
  });

  test("ignores sync_changed events with unrelated tags", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagSyncBridge(), {
      wrapper: createWrapper(queryClient),
    });

    emit(syncEvent([SYNC_TAGS.assistantAvatar, SYNC_TAGS.conversationsList]));

    expect(spy).not.toHaveBeenCalled();
  });

  test("ignores non-sync_changed events", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useFeatureFlagSyncBridge(), {
      wrapper: createWrapper(queryClient),
    });

    emit({ type: "home_feed_updated" } as unknown as AssistantEvent);

    expect(spy).not.toHaveBeenCalled();
  });

  test("unsubscribes on unmount so no further invalidations fire", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    const { unmount } = renderHook(() => useFeatureFlagSyncBridge(), {
      wrapper: createWrapper(queryClient),
    });

    unmount();
    emit(syncEvent([SYNC_TAGS.featureFlagsClient]));

    expect(spy).not.toHaveBeenCalled();
  });
});
