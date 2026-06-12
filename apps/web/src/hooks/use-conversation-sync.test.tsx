import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import type { Conversation } from "@/types/conversation-types";
import {
  conversationGroupsQueryKey,
} from "@/lib/sync/query-tags";
import {
  conversationListInfiniteQueryKey,
  type ConversationPage,
} from "@/utils/conversation-list-fetchers";
import { SYNC_TAGS, type SyncChangedEvent } from "@/lib/sync/types";
import {
  __resetForTesting,
  publish,
} from "@/lib/event-bus";

// ---------------------------------------------------------------------------
// Module mock — `@/utils/fetch-conversation-detail`.
// ---------------------------------------------------------------------------
const realFetchDetailModule = await import(
  "@/utils/fetch-conversation-detail"
);
const { ConversationNotFoundError } = realFetchDetailModule;

let fetchConversationDetailImpl: (
  queryClient: QueryClient,
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

mock.module("@/utils/fetch-conversation-detail", () => ({
  ...realFetchDetailModule,
  fetchConversationDetail: (queryClient: QueryClient, assistantId: string, conversationId: string) => {
    fetchConversationDetailCalls.push({ assistantId, conversationId });
    return fetchConversationDetailImpl(queryClient, assistantId, conversationId);
  },
}));

const { useConversationSync } = await import(
  "@/hooks/use-conversation-sync"
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
  __resetForTesting();
});

describe("useConversationSync", () => {
  test("does not fire when assistant is not active", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useConversationSync("asst-1", false), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.conversationsList]));
    expect(spy).not.toHaveBeenCalled();
  });

  test("does not fire when assistantId is null", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useConversationSync(null, true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.conversationsList]));
    expect(spy).not.toHaveBeenCalled();
  });

  test("debounces conversations:list invalidation", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useConversationSync("asst-1", true), {
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
        const key = arg?.queryKey?.[0] as Record<string, unknown> | undefined;
        return key?._id === "conversationsGet";
      },
    );
    expect(listCalls.length).toBe(1);
  });

  test("per-conversation metadata tags GET-and-patch the cached row (no list refetch)", async () => {
    const queryClient = freshQueryClient();
    const infiniteKey = conversationListInfiniteQueryKey("asst-1");
    queryClient.setQueryData<InfiniteData<ConversationPage>>(infiniteKey, {
      pages: [{
        conversations: [
          {
            conversationId: "conv-1",
            title: "Old title",
            hasUnseenLatestAssistantMessage: true,
            lastSeenAssistantMessageAt: undefined,
          } as Conversation,
          {
            conversationId: "conv-2",
            title: "Untouched",
            hasUnseenLatestAssistantMessage: true,
          } as Conversation,
        ],
        hasMore: false,
        nextOffset: 2,
      }],
      pageParams: [0],
    });
    fetchConversationDetailImpl = async (_queryClient, _assistantId, conversationId) => ({
      conversationId,
      title: "Old title",
      hasUnseenLatestAssistantMessage: false,
      lastSeenAssistantMessageAt: 1779710400000,
    });
    const invalidateSpy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = invalidateSpy as never;

    renderHook(() => useConversationSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent(["conversation:conv-1:metadata"]));

    await waitFor(() => {
      const data = queryClient.getQueryData<InfiniteData<ConversationPage>>(infiniteKey);
      const list = data?.pages.flatMap((p) => p.conversations) ?? [];
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
    const dataAfter = queryClient.getQueryData<InfiniteData<ConversationPage>>(infiniteKey);
    const listAfter = dataAfter?.pages.flatMap((p) => p.conversations) ?? [];
    const conv2 = listAfter.find(
      (c) => c.conversationId === "conv-2",
    );
    expect(conv2?.hasUnseenLatestAssistantMessage).toBe(true);

    // No list-level invalidation fires.
    const listCalls = (
      invalidateSpy.mock.calls as unknown as Array<[unknown]>
    ).filter((call) => {
      const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
      const key = arg?.queryKey?.[0] as Record<string, unknown> | undefined;
      return key?._id === "conversationsGet";
    });
    expect(listCalls.length).toBe(0);
  });

  test("per-conversation metadata tag handles a 404 (deleted-by-other-client) by removing the row", async () => {
    const queryClient = freshQueryClient();
    const infiniteKey = conversationListInfiniteQueryKey("asst-1");
    queryClient.setQueryData<InfiniteData<ConversationPage>>(infiniteKey, {
      pages: [{
        conversations: [
          { conversationId: "conv-1", title: "Tombstone" } as Conversation,
          { conversationId: "conv-2", title: "Survivor" } as Conversation,
        ],
        hasMore: false,
        nextOffset: 2,
      }],
      pageParams: [0],
    });
    fetchConversationDetailImpl = async () => {
      throw new ConversationNotFoundError("conv-1");
    };

    renderHook(() => useConversationSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent(["conversation:conv-1:metadata"]));

    await waitFor(() => {
      const data = queryClient.getQueryData<InfiniteData<ConversationPage>>(infiniteKey);
      const list = data?.pages.flatMap((p) => p.conversations) ?? [];
      expect(
        list.some((c) => c.conversationId === "conv-1"),
      ).toBe(false);
      expect(
        list.some((c) => c.conversationId === "conv-2"),
      ).toBe(true);
    });
  });

  test("per-conversation messages tags do NOT refetch the sidebar list", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useConversationSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent(["conversation:abc:messages"]));
    emit(syncEvent(["conversation:def:messages"]));
    emit(syncEvent(["conversation:ghi:messages"]));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const listCalls = (spy.mock.calls as unknown as Array<[unknown]>).filter(
      (call) => {
        const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
        const key = arg?.queryKey?.[0] as Record<string, unknown> | undefined;
        return key?._id === "conversationsGet";
      },
    );
    expect(listCalls.length).toBe(0);
  });

  test("invalidates conversation list queries on sse.opened reconnect (debounced)", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useConversationSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emitOpened("error");
    // Wait past the 250ms debounce window.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const chatCtxCalls = (spy.mock.calls as unknown as Array<[unknown]>).filter(
      (call) => {
        const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
        const key = arg?.queryKey?.[0] as Record<string, unknown> | undefined;
        return key?._id === "conversationsGet";
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

  test("does NOT invalidate on sse.opened (cause=fresh)", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useConversationSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emitOpened("fresh");
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });

  test("patches conversation title in cache on conversation_title_updated", async () => {
    const queryClient = freshQueryClient();
    const infiniteKey = conversationListInfiniteQueryKey("asst-1");
    queryClient.setQueryData<InfiniteData<ConversationPage>>(infiniteKey, {
      pages: [{
        conversations: [{ conversationId: "conv-1", title: "Old Title" } as Conversation],
        hasMore: false,
        nextOffset: 1,
      }],
      pageParams: [0],
    });
    renderHook(() => useConversationSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    publish("sse.event", {
      id: "evt-title",
      conversationId: "conv-1",
      emittedAt: new Date().toISOString(),
      message: {
        type: "conversation_title_updated",
        conversationId: "conv-1",
        title: "New Title",
      },
    } as AssistantEventEnvelope);
    await waitFor(() => {
      const data = queryClient.getQueryData<InfiniteData<ConversationPage>>(infiniteKey);
      const conv = data?.pages.flatMap((p) => p.conversations).find((c) => c.conversationId === "conv-1");
      expect(conv?.title).toBe("New Title");
    });
  });
});
