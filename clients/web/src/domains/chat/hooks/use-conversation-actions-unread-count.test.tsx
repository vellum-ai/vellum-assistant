/**
 * Optimistic maintenance of the server-side unread count by the seen/unseen
 * actions in `useConversationActions`.
 *
 * The count is authoritative on the server, so the client's job is to keep
 * the badge honest between the user's click and the settle-time refetch:
 * apply a delta that matches the mutation's semantics, revert exactly that
 * delta if the write fails, and invalidate so the server reconciles any
 * drift (including unread messages that landed mid-flight).
 *
 * Reversal is delta-based rather than snapshot-based on purpose: a snapshot
 * restore would discard a concurrent mutation's adjustment.
 *
 * Test shape follows `use-conversation-actions-archive-optimistic.test.tsx`:
 * `mutate()` is fire-and-forget, so each case wraps the handler call in
 * `act()` to flush `onMutate`, asserts the optimistic value, then resolves
 * or rejects the deferred API mock.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import * as sdkGen from "@/generated/daemon/sdk.gen";
import type { Conversation } from "@/types/conversation-types";
import {
  conversationsQueryKey,
  unreadConversationCountQueryKey,
} from "@/utils/conversation-list-fetchers";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

type SeenImpl = (opts: unknown) => Promise<unknown>;

let seenImpl: SeenImpl = async () => ({
  data: undefined,
  response: { ok: true, status: 200 },
});
let unreadImpl: SeenImpl = async () => ({
  data: undefined,
  response: { ok: true, status: 200 },
});
let seenBulkImpl: SeenImpl = async () => ({
  data: undefined,
  response: { ok: true, status: 200 },
});

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  conversationsSeenPost: (opts: unknown) => seenImpl(opts),
  conversationsUnreadPost: (opts: unknown) => unreadImpl(opts),
  conversationsSeenBulkPost: (opts: unknown) => seenBulkImpl(opts),
}));

mock.module("@/utils/haptics", () => ({
  haptic: { medium: () => {}, light: () => {} },
}));

mock.module("@sentry/react", () => ({
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
}));

const { useConversationActions } = await import(
  "@/domains/chat/hooks/use-conversation-actions"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "asst-1";

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return { conversationId: "conv-1", ...overrides };
}

function setupHook(opts: {
  conversations: Conversation[];
  unreadCount?: number | null;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(conversationsQueryKey(ASSISTANT_ID), opts.conversations);
  if (opts.unreadCount !== undefined) {
    client.setQueryData(
      unreadConversationCountQueryKey(ASSISTANT_ID),
      opts.unreadCount,
    );
  }

  const { result } = renderHook(
    () =>
      useConversationActions({
        assistantId: ASSISTANT_ID,
        activeConversationId: null,
        conversations: opts.conversations,
        switchConversation: () => {},
        startNewConversation: () => {},
        prePinGroupIdsRef: { current: new Map() },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    },
  );

  return { result, client };
}

function readCount(client: QueryClient): number | null | undefined {
  return client.getQueryData<number | null>(
    unreadConversationCountQueryKey(ASSISTANT_ID),
  );
}

function deferred<T = { data: undefined; response: { ok: boolean } }>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  seenImpl = async () => ({
    data: undefined,
    response: { ok: true, status: 200 },
  });
  unreadImpl = async () => ({
    data: undefined,
    response: { ok: true, status: 200 },
  });
  seenBulkImpl = async () => ({
    data: undefined,
    response: { ok: true, status: 200 },
  });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Mark read
// ---------------------------------------------------------------------------

describe("handleMarkConversationRead unread count", () => {
  test("decrements before the API resolves", async () => {
    const conv = makeConversation({ hasUnseenLatestAssistantMessage: true });
    const { result, client } = setupHook({
      conversations: [conv],
      unreadCount: 4,
    });

    const d = deferred();
    seenImpl = () => d.promise;

    await act(async () => {
      result.current.handleMarkConversationRead(conv);
    });

    expect(readCount(client)).toBe(3);

    await act(async () => {
      d.resolve({ data: undefined, response: { ok: true } });
    });
  });

  test("reverts the decrement when the API rejects", async () => {
    const conv = makeConversation({ hasUnseenLatestAssistantMessage: true });
    const { result, client } = setupHook({
      conversations: [conv],
      unreadCount: 4,
    });

    seenImpl = async () => {
      throw new Error("network failure");
    };

    await act(async () => {
      result.current.handleMarkConversationRead(conv);
    });

    await waitFor(() => {
      expect(readCount(client)).toBe(4);
    });
  });

  test("does not decrement for a row that never contributed to the count", async () => {
    // An archived row carries unread state but is excluded from the badge,
    // so marking it read must not move the count.
    const conv = makeConversation({
      hasUnseenLatestAssistantMessage: true,
      archivedAt: 1234,
    });
    const { result, client } = setupHook({
      conversations: [conv],
      unreadCount: 4,
    });

    const d = deferred();
    seenImpl = () => d.promise;

    await act(async () => {
      result.current.handleMarkConversationRead(conv);
    });

    expect(readCount(client)).toBe(4);

    await act(async () => {
      d.resolve({ data: undefined, response: { ok: true } });
    });
  });

  test("invalidates the count on settle so the server reconciles drift", async () => {
    // An assistant reply landing mid-flight makes the optimistic value stale;
    // the refetch is what corrects it.
    const conv = makeConversation({ hasUnseenLatestAssistantMessage: true });
    const { result, client } = setupHook({
      conversations: [conv],
      unreadCount: 4,
    });

    expect(
      client.getQueryState(unreadConversationCountQueryKey(ASSISTANT_ID))
        ?.isInvalidated,
    ).toBe(false);

    await act(async () => {
      result.current.handleMarkConversationRead(conv);
    });

    await waitFor(() => {
      expect(
        client.getQueryState(unreadConversationCountQueryKey(ASSISTANT_ID))
          ?.isInvalidated,
      ).toBe(true);
    });
  });

  test("leaves an unavailable count untouched", async () => {
    // `null` means the assistant does not serve the endpoint.
    const conv = makeConversation({ hasUnseenLatestAssistantMessage: true });
    const { result, client } = setupHook({
      conversations: [conv],
      unreadCount: null,
    });

    const d = deferred();
    seenImpl = () => d.promise;

    await act(async () => {
      result.current.handleMarkConversationRead(conv);
    });

    expect(readCount(client)).toBeNull();

    await act(async () => {
      d.resolve({ data: undefined, response: { ok: true } });
    });
  });
});

// ---------------------------------------------------------------------------
// Mark unread
// ---------------------------------------------------------------------------

describe("handleMarkConversationUnread unread count", () => {
  test("increments before the API resolves", async () => {
    const conv = makeConversation({
      hasUnseenLatestAssistantMessage: false,
      latestAssistantMessageAt: 1234,
    });
    const { result, client } = setupHook({
      conversations: [conv],
      unreadCount: 4,
    });

    const d = deferred();
    unreadImpl = () => d.promise;

    await act(async () => {
      result.current.handleMarkConversationUnread(conv);
    });

    expect(readCount(client)).toBe(5);

    await act(async () => {
      d.resolve({ data: undefined, response: { ok: true } });
    });
  });

  test("reverts the increment when the API rejects", async () => {
    const conv = makeConversation({
      hasUnseenLatestAssistantMessage: false,
      latestAssistantMessageAt: 1234,
    });
    const { result, client } = setupHook({
      conversations: [conv],
      unreadCount: 4,
    });

    unreadImpl = async () => {
      throw new Error("network failure");
    };

    await act(async () => {
      result.current.handleMarkConversationUnread(conv);
    });

    await waitFor(() => {
      expect(readCount(client)).toBe(4);
    });
  });

  test("does not increment for a row that cannot contribute to the count", async () => {
    const conv = makeConversation({
      hasUnseenLatestAssistantMessage: false,
      latestAssistantMessageAt: 1234,
      archivedAt: 5678,
    });
    const { result, client } = setupHook({
      conversations: [conv],
      unreadCount: 4,
    });

    const d = deferred();
    unreadImpl = () => d.promise;

    await act(async () => {
      result.current.handleMarkConversationUnread(conv);
    });

    expect(readCount(client)).toBe(4);

    await act(async () => {
      d.resolve({ data: undefined, response: { ok: true } });
    });
  });
});

// ---------------------------------------------------------------------------
// Mark all read in group
// ---------------------------------------------------------------------------

describe("handleMarkAllReadInGroup unread count", () => {
  test("decrements once per contributing row", async () => {
    const rows = [
      makeConversation({
        conversationId: "a",
        hasUnseenLatestAssistantMessage: true,
      }),
      makeConversation({
        conversationId: "b",
        hasUnseenLatestAssistantMessage: true,
      }),
      // Archived: unread, but excluded from the badge.
      makeConversation({
        conversationId: "c",
        hasUnseenLatestAssistantMessage: true,
        archivedAt: 1234,
      }),
      makeConversation({
        conversationId: "d",
        hasUnseenLatestAssistantMessage: false,
      }),
    ];
    const { result, client } = setupHook({
      conversations: rows,
      unreadCount: 6,
    });

    await act(async () => {
      await result.current.handleMarkAllReadInGroup(rows);
    });

    // Only "a" and "b" contributed, so the count drops by exactly 2.
    await waitFor(() => {
      expect(readCount(client)).toBe(4);
    });
  });

  test("restores the decrement for rows the bulk write failed", async () => {
    const rows = [
      makeConversation({
        conversationId: "a",
        hasUnseenLatestAssistantMessage: true,
      }),
      makeConversation({
        conversationId: "b",
        hasUnseenLatestAssistantMessage: true,
      }),
    ];
    const { result, client } = setupHook({
      conversations: rows,
      unreadCount: 6,
    });

    seenBulkImpl = async () => ({
      data: undefined,
      error: { message: "boom" },
      response: { ok: false, status: 500 },
    });

    await act(async () => {
      await result.current.handleMarkAllReadInGroup(rows);
    });

    // Every row rolled back, so the count returns to its starting value.
    await waitFor(() => {
      expect(readCount(client)).toBe(6);
    });
  });
});
