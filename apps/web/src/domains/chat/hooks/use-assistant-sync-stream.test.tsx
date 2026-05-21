import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { AssistantEvent } from "@/domains/chat/api/event-types.js";
import { assistantIdentityQueryKey } from "@/hooks/use-assistant-identity-init.js";
import {
  assistantDaemonConfigQueryKey,
  assistantSchedulesQueryKey,
  assistantSoundsConfigQueryKey,
  avatarQueryKey,
  chatContextQueryKey,
} from "@/lib/sync/query-tags.js";
import { SYNC_TAGS, type SyncChangedEvent } from "@/lib/sync/types.js";

type EventHandler = (event: AssistantEvent) => void;

let activeHandler: EventHandler | null = null;
let lastSubscribeArgs: {
  assistantId: string;
  conversationKey: string | null | undefined;
} | null = null;
const cancelMock = mock(() => {});
const subscribeChatEventsMock = mock(
  (
    assistantId: string,
    conversationKey: string | null | undefined,
    onEvent: EventHandler,
    _onError: (err: Error) => void,
  ) => {
    lastSubscribeArgs = { assistantId, conversationKey };
    activeHandler = onEvent;
    return { cancel: cancelMock };
  },
);

mock.module("@/domains/chat/api/stream.js", () => ({
  subscribeChatEvents: subscribeChatEventsMock,
}));

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

beforeEach(() => {
  activeHandler = null;
  lastSubscribeArgs = null;
  cancelMock.mockClear();
  subscribeChatEventsMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("useAssistantSyncStream", () => {
  test("does not subscribe when assistant is not active", () => {
    const queryClient = freshQueryClient();
    renderHook(() => useAssistantSyncStream("asst-1", false), {
      wrapper: createWrapper(queryClient),
    });
    expect(subscribeChatEventsMock).not.toHaveBeenCalled();
  });

  test("does not subscribe when assistantId is null", () => {
    const queryClient = freshQueryClient();
    renderHook(() => useAssistantSyncStream(null, true), {
      wrapper: createWrapper(queryClient),
    });
    expect(subscribeChatEventsMock).not.toHaveBeenCalled();
  });

  test("opens an unfiltered (null conversation key) stream when active", () => {
    const queryClient = freshQueryClient();
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    expect(lastSubscribeArgs).toEqual({
      assistantId: "asst-1",
      conversationKey: null,
    });
  });

  test("cancels the stream on unmount", () => {
    const queryClient = freshQueryClient();
    const { unmount } = renderHook(
      () => useAssistantSyncStream("asst-1", true),
      { wrapper: createWrapper(queryClient) },
    );
    expect(cancelMock).not.toHaveBeenCalled();
    unmount();
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  test("invalidates avatar query on assistant:self:avatar sync tag", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    activeHandler!(syncEvent([SYNC_TAGS.assistantAvatar]));
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
    activeHandler!(syncEvent([SYNC_TAGS.assistantIdentity]));
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
    activeHandler!(
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
    activeHandler!(syncEvent([SYNC_TAGS.conversationsList]));
    activeHandler!(syncEvent([SYNC_TAGS.conversationsList]));
    activeHandler!(syncEvent([SYNC_TAGS.conversationsList]));
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
    // Fabricate a non-sync event — handler should not touch the cache.
    activeHandler!({
      type: "assistant_text_delta",
      conversationId: "convo-1",
      delta: "hi",
    } as unknown as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("per-conversation metadata/messages tags schedule a debounced list refresh", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantSyncStream("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    activeHandler!(syncEvent(["conversation:abc:metadata"]));
    activeHandler!(syncEvent(["conversation:abc:messages"]));
    // Both tags fall into the default branch and trigger the
    // debounced sidebar refresh — coalesced into a single invalidate.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const listCalls = (spy.mock.calls as unknown as Array<[unknown]>).filter(
      (call) => {
        const arg = call[0] as { queryKey: readonly unknown[] } | undefined;
        return arg?.queryKey?.[0] === chatContextQueryKey("asst-1")[0];
      },
    );
    expect(listCalls.length).toBe(1);
  });

  test("cancels the stream when isAssistantActive flips true -> false", () => {
    const queryClient = freshQueryClient();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useAssistantSyncStream("asst-1", active),
      {
        wrapper: createWrapper(queryClient),
        initialProps: { active: true },
      },
    );
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).not.toHaveBeenCalled();
    rerender({ active: false });
    expect(cancelMock).toHaveBeenCalledTimes(1);
    // Stays cancelled — no new subscribe while inactive.
    expect(subscribeChatEventsMock).toHaveBeenCalledTimes(1);
  });
});
