import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { AssistantEvent } from "@/types/event-types";
import { useAssistantResourceSync } from "@/hooks/use-assistant-resource-sync";
import {
  assistantDaemonConfigQueryKey,
  assistantIdentityQueryKey,
  assistantSchedulesQueryKey,
  assistantSoundsConfigQueryKey,
  avatarQueryKey,
  HOME_FEED_QUERY_KEY_PREFIX,
  HOME_STATE_QUERY_KEY_PREFIX,
} from "@/lib/sync/query-tags";
import { SYNC_TAGS, type SyncChangedEvent } from "@/lib/sync/types";
import {
  __resetEventBusForTesting,
  useEventBusStore,
} from "@/stores/event-bus-store";

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

describe("useAssistantResourceSync", () => {
  test("does not fire when assistant is not active", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", false), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]) as unknown as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("does not fire when assistantId is null", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync(null, true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]) as unknown as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("invalidates avatar query on assistant:self:avatar sync tag", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]) as unknown as AssistantEvent);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: avatarQueryKey("asst-1"),
      });
    });
  });

  test("invalidates identity query on assistant:self:identity sync tag", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(
      syncEvent([SYNC_TAGS.assistantIdentity]) as unknown as AssistantEvent,
    );
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: assistantIdentityQueryKey("asst-1"),
      });
    });
  });

  test("invalidates config / sounds / schedules queries on their sync tags", async () => {
    const queryClient = freshQueryClient();
    const calls: unknown[][] = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      calls.push([arg]);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(
      syncEvent([
        SYNC_TAGS.assistantConfig,
        SYNC_TAGS.assistantSounds,
        SYNC_TAGS.assistantSchedules,
      ]) as unknown as AssistantEvent,
    );
    await waitFor(() => {
      const queryKeys = calls.map(
        ([arg]) => (arg as { queryKey: readonly unknown[] }).queryKey,
      );
      expect(queryKeys).toEqual(
        expect.arrayContaining([
          assistantDaemonConfigQueryKey("asst-1"),
          assistantSoundsConfigQueryKey("asst-1"),
          assistantSchedulesQueryKey("asst-1"),
        ]) as never,
      );
    });
  });

  test("invalidates home-feed query on home_feed_updated", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({
      type: "home_feed_updated",
      updatedAt: "2026-05-21T00:00:00Z",
      newItemCount: 1,
    } as unknown as AssistantEvent);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: [HOME_FEED_QUERY_KEY_PREFIX],
      });
    });
  });

  test("invalidates both home-feed and home-state on relationship_state_updated", async () => {
    const queryClient = freshQueryClient();
    const calls: unknown[][] = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      calls.push([arg]);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({
      type: "relationship_state_updated",
      updatedAt: "2026-05-21T00:00:00Z",
    } as unknown as AssistantEvent);
    await waitFor(() => {
      const queryKeys = calls.map(
        ([arg]) => (arg as { queryKey: readonly unknown[] }).queryKey,
      );
      expect(queryKeys).toEqual(
        expect.arrayContaining([
          [HOME_FEED_QUERY_KEY_PREFIX],
          [HOME_STATE_QUERY_KEY_PREFIX],
        ]) as never,
      );
    });
  });

  test("invalidates identity query on identity_changed event", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({ type: "identity_changed" } as unknown as AssistantEvent);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: assistantIdentityQueryKey("asst-1"),
      });
    });
  });

  test("invalidates avatar query on avatar_updated event", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({ type: "avatar_updated" } as unknown as AssistantEvent);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: avatarQueryKey("asst-1"),
      });
    });
  });

  test("ignores conversation-scoped events (text deltas, tool calls, etc.)", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({
      type: "assistant_text_delta",
      conversationId: "convo-1",
      delta: "hi",
    } as unknown as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("unsubscribes from the bus when isAssistantActive flips true -> false", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useAssistantResourceSync("asst-1", active),
      {
        wrapper: createWrapper(queryClient),
        initialProps: { active: true },
      },
    );
    emit(syncEvent([SYNC_TAGS.assistantAvatar]) as unknown as AssistantEvent);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    rerender({ active: false });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]) as unknown as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });
});
