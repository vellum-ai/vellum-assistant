import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { AssistantEvent } from "@/domains/chat/api/event-types.js";
import { assistantIdentityQueryKey } from "@/hooks/use-assistant-identity-init.js";
import { ASSISTANT_FLAG_VALUES_QUERY_KEY } from "@/lib/feature-flags/use-assistant-feature-flag-sync.js";
import { CLIENT_FLAG_QUERY_KEY } from "@/lib/feature-flags/use-client-feature-flag-sync.js";
import {
  assistantDaemonConfigQueryKey,
  assistantSchedulesQueryKey,
  assistantSoundsConfigQueryKey,
  avatarQueryKey,
  chatContextQueryKey,
} from "@/lib/sync/query-tags.js";
import { SYNC_TAGS, type SyncChangedEvent } from "@/lib/sync/types.js";
import {
  __resetEventBusForTesting,
  useEventBusStore,
} from "@/stores/event-bus-store.js";

const { useAssistantSyncStream } = await import(
  "@/domains/chat/hooks/use-assistant-sync-stream.js"
);

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

function emitOpened(
  cause: "fresh" | "error" | "watchdog" | "resume",
  assistantId = "asst-1",
): void {
  useEventBusStore.getState().publish("sse.opened", { assistantId, cause });
}

beforeEach(() => {
  __resetEventBusForTesting();
});

afterEach(() => {
  cleanup();
  __resetEventBusForTesting();
});

describe("useAssistantSyncStream", () => {
  test("does not subscribe to bus events when assistant is not active", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", false), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]));
    expect(spy).not.toHaveBeenCalled();
  });

  test("does not subscribe when assistantId is null", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream(null, true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]));
    expect(spy).not.toHaveBeenCalled();
  });

  test("invalidates avatar query on assistant:self:avatar sync tag", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]));
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
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantIdentity]));
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
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(
      syncEvent([
        SYNC_TAGS.assistantConfig,
        SYNC_TAGS.assistantSounds,
        SYNC_TAGS.assistantSchedules,
      ]),
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

  test("debounces conversations:list invalidation", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.conversationsList]));
    emit(syncEvent([SYNC_TAGS.conversationsList]));
    emit(syncEvent([SYNC_TAGS.conversationsList]));
    // Debounced — wait past the 250ms window.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const listCalls = (spy.mock.calls as unknown as Array<[unknown]>).filter(
      (call) => {
        const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
        return arg?.queryKey?.[0] === chatContextQueryKey("asst-1")[0];
      },
    );
    expect(listCalls.length).toBe(1);
  });

  test("ignores conversation-scoped events (text deltas, tool calls, etc.)", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({
      type: "assistant_text_delta",
      conversationId: "convo-1",
      delta: "hi",
    } as unknown as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("per-conversation metadata tags schedule a debounced list refresh", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent(["conversation:abc:metadata"]));
    emit(syncEvent(["conversation:abc:metadata"]));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const listCalls = (spy.mock.calls as unknown as Array<[unknown]>).filter(
      (call) => {
        const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
        return arg?.queryKey?.[0] === chatContextQueryKey("asst-1")[0];
      },
    );
    expect(listCalls.length).toBe(1);
  });

  test("per-conversation messages tags do NOT refetch the sidebar list", async () => {
    // `:messages` tags fire on every message persist. Repaginating
    // the full conversation list each time was the 14-request swarm
    // this PR exists to eliminate. The default branch must filter
    // those tags out before reaching `scheduleConversationListRefetch`.
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent(["conversation:abc:messages"]));
    emit(syncEvent(["conversation:def:messages"]));
    emit(syncEvent(["conversation:ghi:messages"]));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const listCalls = (spy.mock.calls as unknown as Array<[unknown]>).filter(
      (call) => {
        const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
        return arg?.queryKey?.[0] === chatContextQueryKey("asst-1")[0];
      },
    );
    expect(listCalls.length).toBe(0);
  });

  test("conversation_seen_changed patches the cached conversation row without refetching the list", async () => {
    // The daemon emits this event in lieu of the old `conversationsList`
    // sync fan-out for seen/unread mutations. Verify (a) the targeted
    // row is patched in-place with the new attention state and
    // (b) no list-level invalidation fires — that was the source of the
    // ~14-request sidebar redrain on every conversation switch.
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    // Seed the cache with one unseen conversation we expect to be patched
    // and one that should remain untouched.
    queryClient.setQueryData(chatContextQueryKey("asst-1"), {
      assistantId: "asst-1",
      conversationId: "conv-1",
      conversations: [
        {
          conversationId: "conv-1",
          title: "Unseen",
          hasUnseenLatestAssistantMessage: true,
          latestAssistantMessageAt: "2026-05-25T00:00:00.000Z",
          lastSeenAssistantMessageAt: undefined,
        },
        {
          conversationId: "conv-2",
          title: "Other",
          hasUnseenLatestAssistantMessage: true,
          latestAssistantMessageAt: "2026-05-24T00:00:00.000Z",
          lastSeenAssistantMessageAt: undefined,
        },
      ],
    });
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });

    const seenAt = Date.UTC(2026, 4, 25, 12, 0, 0); // 2026-05-25T12:00:00.000Z
    emit({
      type: "conversation_seen_changed",
      conversationId: "conv-1",
      hasUnseenLatestAssistantMessage: false,
      latestAssistantMessageAt: seenAt,
      lastSeenAssistantMessageAt: seenAt,
    } as unknown as AssistantEvent);

    await waitFor(() => {
      const ctx = queryClient.getQueryData(chatContextQueryKey("asst-1")) as {
        conversations: Array<{
          conversationId: string;
          hasUnseenLatestAssistantMessage?: boolean;
          lastSeenAssistantMessageAt?: string;
        }>;
      };
      const conv1 = ctx.conversations.find((c) => c.conversationId === "conv-1");
      expect(conv1?.hasUnseenLatestAssistantMessage).toBe(false);
      expect(conv1?.lastSeenAssistantMessageAt).toBe(
        new Date(seenAt).toISOString(),
      );
    });

    // Untouched row stays untouched.
    const ctxAfter = queryClient.getQueryData(chatContextQueryKey("asst-1")) as {
      conversations: Array<{
        conversationId: string;
        hasUnseenLatestAssistantMessage?: boolean;
      }>;
    };
    const conv2 = ctxAfter.conversations.find(
      (c) => c.conversationId === "conv-2",
    );
    expect(conv2?.hasUnseenLatestAssistantMessage).toBe(true);

    // And critically — no list invalidation.
    const listCalls = (spy.mock.calls as unknown as Array<[unknown]>).filter(
      (call) => {
        const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
        return arg?.queryKey?.[0] === chatContextQueryKey("asst-1")[0];
      },
    );
    expect(listCalls.length).toBe(0);
  });

  test("conversation_seen_changed with hasUnseen=true (mark-unread echo) patches the row", async () => {
    // Symmetric to the seen case — verify the publisher handles both
    // directions of the seen/unread toggle. This is the path the
    // mark-unread mutation echoes back through to sibling clients.
    const queryClient = freshQueryClient();
    queryClient.setQueryData(chatContextQueryKey("asst-1"), {
      assistantId: "asst-1",
      conversationId: "conv-1",
      conversations: [
        {
          conversationId: "conv-1",
          title: "Was seen",
          hasUnseenLatestAssistantMessage: false,
          latestAssistantMessageAt: "2026-05-25T00:00:00.000Z",
          lastSeenAssistantMessageAt: "2026-05-25T00:00:00.000Z",
        },
      ],
    });
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });

    emit({
      type: "conversation_seen_changed",
      conversationId: "conv-1",
      hasUnseenLatestAssistantMessage: true,
      latestAssistantMessageAt: Date.UTC(2026, 4, 25, 0, 0, 0),
      lastSeenAssistantMessageAt: Date.UTC(2026, 4, 25, 0, 0, 0),
    } as unknown as AssistantEvent);

    await waitFor(() => {
      const ctx = queryClient.getQueryData(chatContextQueryKey("asst-1")) as {
        conversations: Array<{
          conversationId: string;
          hasUnseenLatestAssistantMessage?: boolean;
        }>;
      };
      const conv1 = ctx.conversations.find((c) => c.conversationId === "conv-1");
      expect(conv1?.hasUnseenLatestAssistantMessage).toBe(true);
    });
  });

  test("invalidates home-feed queries on home_feed_updated and relationship_state_updated", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({
      type: "home_feed_updated",
      updatedAt: "2026-05-21T00:00:00Z",
      newItemCount: 1,
    } as unknown as AssistantEvent);
    emit({
      type: "relationship_state_updated",
      updatedAt: "2026-05-21T00:00:00Z",
    } as unknown as AssistantEvent);
    await waitFor(() => {
      const homeCalls = (spy.mock.calls as unknown as Array<[unknown]>).filter(
        (call) => {
          const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
          return arg?.queryKey?.[0] === "home-feed";
        },
      );
      expect(homeCalls.length).toBe(2);
    });
  });

  test("invalidates client feature flag query on feature-flags:client sync tag", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
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
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.featureFlagsAssistant]));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: [ASSISTANT_FLAG_VALUES_QUERY_KEY],
      });
    });
  });

  test("invalidates both flag queries on sse.opened reconnect (cause=error)", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emitOpened("error");
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: CLIENT_FLAG_QUERY_KEY });
      expect(spy).toHaveBeenCalledWith({
        queryKey: [ASSISTANT_FLAG_VALUES_QUERY_KEY],
      });
    });
  });

  test("invalidates both flag queries on sse.opened (cause=watchdog and cause=resume)", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emitOpened("watchdog");
    emitOpened("resume");
    await waitFor(() => {
      // 2 emits × 2 query keys = 4 invalidate calls.
      expect(spy).toHaveBeenCalledTimes(4);
    });
  });

  test("does NOT invalidate on sse.opened (cause=fresh) — initial mount fetch covers it", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emitOpened("fresh");
    // Give the bus a microtask to deliver.
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });

  test("unsubscribes from the bus when isAssistantActive flips true -> false", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useAssistantSyncStream("asst-1", active),
      {
        wrapper: createWrapper(queryClient),
        initialProps: { active: true },
      },
    );
    emit(syncEvent([SYNC_TAGS.assistantAvatar]));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    rerender({ active: false });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]));
    expect(spy).not.toHaveBeenCalled();
  });
});
