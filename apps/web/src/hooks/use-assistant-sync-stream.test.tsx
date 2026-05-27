import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { AssistantEvent } from "@/domains/chat/api/event-types";
import { assistantIdentityQueryKey } from "@/hooks/use-assistant-identity-init";
import { ASSISTANT_FLAG_VALUES_QUERY_KEY } from "@/lib/feature-flags/use-assistant-feature-flag-sync";
import { CLIENT_FLAG_QUERY_KEY } from "@/lib/feature-flags/use-client-feature-flag-sync";
import {
  assistantDaemonConfigQueryKey,
  assistantSchedulesQueryKey,
  assistantSoundsConfigQueryKey,
  avatarQueryKey,
  conversationsQueryKey,
} from "@/lib/sync/query-tags";
import { conversationGroupsQueryKey } from "@/domains/conversations/conversation-queries";
import { SYNC_TAGS, type SyncChangedEvent } from "@/lib/sync/types";
import {
  __resetEventBusForTesting,
  useEventBusStore,
} from "@/stores/event-bus-store";

// ---------------------------------------------------------------------------
// Module mock — `@/lib/conversations-api`.
//
// `refreshConversationRow` (in `conversation-queries.ts`) calls
// `fetchConversationDetail` to GET the post-mutation row. We spread the
// real module so every other consumer keeps its original behavior, and
// only override `fetchConversationDetail` to a configurable impl. The
// default `fetchConversationDetailImpl` throws so any test that doesn't
// set up its own impl fails loudly instead of making a real network call.
// ---------------------------------------------------------------------------
const realConversationsModule = await import(
  "@/lib/conversations-api"
);
const { CONVERSATION_NOT_FOUND } = realConversationsModule;

let fetchConversationDetailImpl: (
  assistantId: string,
  conversationId: string,
) => Promise<unknown> = () =>
  Promise.reject(
    new Error(
      "fetchConversationDetail mock not configured — set fetchConversationDetailImpl in the test",
    ),
  );
const fetchConversationDetailCalls: Array<{
  assistantId: string;
  conversationId: string;
}> = [];

mock.module("@/lib/conversations-api", () => ({
  ...realConversationsModule,
  fetchConversationDetail: (assistantId: string, conversationId: string) => {
    fetchConversationDetailCalls.push({ assistantId, conversationId });
    return fetchConversationDetailImpl(assistantId, conversationId);
  },
}));

const { useAssistantSyncStream } = await import(
  "@/hooks/use-assistant-sync-stream"
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
  fetchConversationDetailCalls.length = 0;
  fetchConversationDetailImpl = () =>
    Promise.reject(
      new Error(
        "fetchConversationDetail mock not configured — set fetchConversationDetailImpl in the test",
      ),
    );
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
        return arg?.queryKey?.[0] === conversationsQueryKey("asst-1")[0];
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

  test("per-conversation metadata tags GET-and-patch the cached row (no list refetch)", async () => {
    // `conversation:<id>:metadata` is the per-row content signal. The
    // hook resolves it by calling `fetchConversationDetail` for that
    // single conversation and replacing the row in the cached chat
    // context — NOT by invalidating the full paginated list (which
    // used to trigger the ~14-request sidebar drain on a few hundred
    // conversations). This test pins (a) the GET fires for the right
    // id and (b) the cache patch reflects the response.
    const queryClient = freshQueryClient();
    queryClient.setQueryData(conversationsQueryKey("asst-1"), [
      {
        conversationId: "conv-1",
        title: "Old title",
        hasUnseenLatestAssistantMessage: true,
        lastSeenAssistantMessageAt: undefined,
      },
      {
        conversationId: "conv-2",
        title: "Untouched",
        hasUnseenLatestAssistantMessage: true,
      },
    ]);
    fetchConversationDetailImpl = async (_assistantId, conversationId) => ({
      conversationId,
      title: "Old title",
      hasUnseenLatestAssistantMessage: false,
      lastSeenAssistantMessageAt: 1779710400000,
    });
    const invalidateSpy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = invalidateSpy as never;

    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent(["conversation:conv-1:metadata"]));

    await waitFor(() => {
      const list = queryClient.getQueryData(conversationsQueryKey("asst-1")) as Array<{
        conversationId: string;
        hasUnseenLatestAssistantMessage?: boolean;
        lastSeenAssistantMessageAt?: number;
      }>;
      const conv1 = list.find(
        (c) => c.conversationId === "conv-1",
      );
      expect(conv1?.hasUnseenLatestAssistantMessage).toBe(false);
      expect(conv1?.lastSeenAssistantMessageAt).toBe(1779710400000);
    });

    // Fetch happened for the right id.
    expect(fetchConversationDetailCalls).toEqual([
      { assistantId: "asst-1", conversationId: "conv-1" },
    ]);

    // Untouched row stays untouched.
    const listAfter = queryClient.getQueryData(
      conversationsQueryKey("asst-1"),
    ) as Array<{
      conversationId: string;
      hasUnseenLatestAssistantMessage?: boolean;
    }>;
    const conv2 = listAfter.find(
      (c) => c.conversationId === "conv-2",
    );
    expect(conv2?.hasUnseenLatestAssistantMessage).toBe(true);

    // Critically — no list-level invalidation fires.
    const listCalls = (
      invalidateSpy.mock.calls as unknown as Array<[unknown]>
    ).filter((call) => {
      const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
      return arg?.queryKey?.[0] === conversationsQueryKey("asst-1")[0];
    });
    expect(listCalls.length).toBe(0);
  });

  test("per-conversation metadata tag handles a 404 (deleted-by-other-client) by removing the row", async () => {
    // If the row was deleted between the sync signal and our GET, the
    // server returns 404 and `fetchConversationDetail` resolves to the
    // `CONVERSATION_NOT_FOUND` sentinel. `refreshConversationRow` should
    // call `removeConversation` so the sidebar drops the stale row
    // instead of leaving it as a tombstone.
    const queryClient = freshQueryClient();
    queryClient.setQueryData(conversationsQueryKey("asst-1"), [
      { conversationId: "conv-1", title: "Tombstone" },
      { conversationId: "conv-2", title: "Survivor" },
    ]);
    fetchConversationDetailImpl = async () => CONVERSATION_NOT_FOUND;

    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent(["conversation:conv-1:metadata"]));

    await waitFor(() => {
      const list = queryClient.getQueryData(conversationsQueryKey("asst-1")) as Array<{ conversationId: string }>;
      expect(
        list.some((c) => c.conversationId === "conv-1"),
      ).toBe(false);
      expect(
        list.some((c) => c.conversationId === "conv-2"),
      ).toBe(true);
    });
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
        return arg?.queryKey?.[0] === conversationsQueryKey("asst-1")[0];
      },
    );
    expect(listCalls.length).toBe(0);
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
      // 2 emits × 2 flag query keys = 4 flag invalidation calls
      // (conversation list calls are debounced and fire later).
      expect(spy).toHaveBeenCalledWith({ queryKey: CLIENT_FLAG_QUERY_KEY });
      expect(spy).toHaveBeenCalledWith({
        queryKey: [ASSISTANT_FLAG_VALUES_QUERY_KEY],
      });
    });
  });

  test("invalidates conversation list queries on sse.opened reconnect (debounced)", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emitOpened("error");
    // Wait past the 250ms debounce window.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const chatCtxCalls = (spy.mock.calls as unknown as Array<[unknown]>).filter(
      (call) => {
        const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
        return arg?.queryKey?.[0] === conversationsQueryKey("asst-1")[0];
      },
    );
    const expectedGroupsKey = conversationGroupsQueryKey("asst-1")[0];
    const groupsCalls = (spy.mock.calls as unknown as Array<[unknown]>).filter(
      (call) => {
        const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
        const key = arg?.queryKey?.[0] as Record<string, unknown> | undefined;
        return key?._id === (expectedGroupsKey as Record<string, unknown>)._id;
      },
    );
    expect(chatCtxCalls.length).toBe(1);
    expect(groupsCalls.length).toBe(1);
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
