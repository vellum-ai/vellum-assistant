/**
 * Which unread number reaches the Electron Dock badge.
 *
 * The server-side count covers every conversation; the client-derived count
 * only covers rows the client has loaded. The badge prefers the server value
 * and falls back to the derived one when the count is unavailable, so an
 * assistant that predates `GET /v1/conversations/unread-count` keeps the
 * behavior it has today.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import type { Conversation } from "@/types/conversation-types";
import * as listFetchers from "@/utils/conversation-list-fetchers";
import { unreadConversationCountQueryKey } from "@/utils/conversation-list-fetchers";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const setDockBadgeCalls: number[] = [];

/**
 * Stands in for the count endpoint so no case reaches the network. Each test
 * sets it to the value the server would return; the default never settles,
 * modelling a request still in flight.
 */
let unreadCountImpl: () => Promise<number | null> = () => new Promise(() => {});

mock.module("@/utils/conversation-list-fetchers", () => ({
  ...listFetchers,
  fetchUnreadConversationCount: () => unreadCountImpl(),
}));

mock.module("@/runtime/dock", () => ({
  setDockBadge: (count: number) => {
    setDockBadgeCalls.push(count);
  },
}));

// The hook gates its query on the Electron host; the badge only exists there.
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => true,
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

const { useElectronDockSync } = await import(
  "@/domains/chat/hooks/use-electron-dock-sync"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "asst-1";

function unread(conversationId: string): Conversation {
  return {
    conversationId,
    hasUnseenLatestAssistantMessage: true,
  } as Conversation;
}

function setup(opts: {
  conversations: Conversation[];
  serverCount?: number | null;
  isAssistantActive?: boolean;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (opts.serverCount !== undefined) {
    const count = opts.serverCount;
    unreadCountImpl = async () => count;
    client.setQueryData(unreadConversationCountQueryKey(ASSISTANT_ID), count);
  }

  renderHook(
    () =>
      useElectronDockSync(
        ASSISTANT_ID,
        opts.conversations,
        opts.isAssistantActive ?? true,
      ),
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    },
  );

  return { client };
}

beforeEach(() => {
  setDockBadgeCalls.length = 0;
  unreadCountImpl = () => new Promise(() => {});
});

afterEach(() => {
  cleanup();
});

describe("useElectronDockSync", () => {
  test("publishes the server count in preference to the loaded-rows count", async () => {
    // The client has 2 unread rows loaded but the server knows about 9.
    // Publishing 2 is the under-count this slice exists to remove.
    setup({
      conversations: [unread("a"), unread("b")],
      serverCount: 9,
    });

    await waitFor(() => {
      expect(setDockBadgeCalls.at(-1)).toBe(9);
    });
  });

  test("publishes a server count of zero rather than falling back", async () => {
    // Zero is a real answer. Falling back here would light the badge for
    // rows the server has already counted as seen.
    setup({
      conversations: [unread("a"), unread("b")],
      serverCount: 0,
    });

    await waitFor(() => {
      expect(setDockBadgeCalls.at(-1)).toBe(0);
    });
  });

  test("falls back to counting loaded rows when the count is unavailable", async () => {
    // `null` is what an assistant without the endpoint resolves to.
    setup({
      conversations: [unread("a"), unread("b")],
      serverCount: null,
    });

    await waitFor(() => {
      expect(setDockBadgeCalls.at(-1)).toBe(2);
    });
  });

  test("falls back while the count query has not resolved", async () => {
    setup({ conversations: [unread("a")] });

    await waitFor(() => {
      expect(setDockBadgeCalls.at(-1)).toBe(1);
    });
  });

  test("does not query a starting assistant, and still publishes a badge", async () => {
    // `ChatLayout` mounts before the assistant is active. Querying then spends
    // the retry budget on a request that cannot succeed, so the badge falls
    // back to the loaded rows until the assistant comes up.
    let queried = false;
    unreadCountImpl = async () => {
      queried = true;
      return 9;
    };

    setup({
      conversations: [unread("a"), unread("b")],
      isAssistantActive: false,
    });

    await waitFor(() => {
      expect(setDockBadgeCalls.at(-1)).toBe(2);
    });
    expect(queried).toBe(false);
  });

  test("never publishes a negative badge", async () => {
    // Optimistic decrements are deliberately unclamped so a revert is exact,
    // so the cached count can dip below zero; display is where that is
    // resolved.
    setup({ conversations: [], serverCount: -2 });

    await waitFor(() => {
      expect(setDockBadgeCalls.at(-1)).toBe(0);
    });
  });

  test("excludes archived and background rows from the fallback count", async () => {
    setup({
      conversations: [
        unread("a"),
        { ...unread("b"), archivedAt: 1234 } as Conversation,
        { ...unread("c"), conversationType: "background" } as Conversation,
      ],
      serverCount: null,
    });

    await waitFor(() => {
      expect(setDockBadgeCalls.at(-1)).toBe(1);
    });
  });
});
