/**
 * Tests for pin/unpin as a *placement*: the section caches, not the fields.
 *
 * **The bug these tests guard against.** Every sidebar section fetches its own
 * rows through a server filter (LUM-2443), so a section's membership is the
 * contents of its cache entry rather than something the client derives.
 * Pinning used to rewrite `isPinned` / `groupId` on the row and stop there, so
 * no cache moved it: the row appeared in Pinned only once Pinned's refetch
 * landed, and stayed in the section it came from until *that* section's
 * refetch landed. Those are separate requests of very different cost, which is
 * why the row was visibly in two sections at once in between.
 *
 * The assertions count copies across every seeded section rather than checking
 * the destination, because the old behavior satisfies "Pinned contains the
 * row" perfectly well. What it violates is "a conversation appears in exactly
 * one section, never twice".
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import * as sdkGen from "@/generated/daemon/sdk.gen";
import type { Conversation } from "@/types/conversation-types";
import {
  conversationsQueryKey,
  sectionConversationsQueryKey,
  type SectionConversationFilter,
} from "@/utils/conversation-list-fetchers";

type ReorderImpl = (opts: unknown) => Promise<{
  data: undefined;
  response: { ok: boolean };
}>;

let reorderImpl: ReorderImpl = async () => ({
  data: undefined,
  response: { ok: true },
});

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  conversationsReorderPost: (opts: unknown) => reorderImpl(opts),
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
const PINNED: SectionConversationFilter = { groupId: "system:pinned" };
const SLACK: SectionConversationFilter = {
  groupId: "system:all",
  originChannel: "slack",
};

const SLACK_ROW: Conversation = {
  conversationId: "c1",
  originChannel: "slack",
  lastMessageAt: 1_000,
};

function setup(sections: Array<[SectionConversationFilter, Conversation[]]>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData<Conversation[]>(conversationsQueryKey(ASSISTANT_ID), [
    SLACK_ROW,
  ]);
  for (const [filter, rows] of sections) {
    client.setQueryData(
      sectionConversationsQueryKey(ASSISTANT_ID, filter),
      rows,
    );
  }

  const { result } = renderHook(
    () =>
      useConversationActions({
        assistantId: ASSISTANT_ID,
        activeConversationId: null,
        conversations: [SLACK_ROW],
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

function idsIn(
  client: QueryClient,
  filter: SectionConversationFilter,
): string[] {
  return (
    client
      .getQueryData<
        Conversation[]
      >(sectionConversationsQueryKey(ASSISTANT_ID, filter))
      ?.map((c) => c.conversationId) ?? []
  );
}

function copies(client: QueryClient, conversationId: string): number {
  return [PINNED, SLACK].reduce(
    (total, filter) =>
      total +
      idsIn(client, filter).filter((id) => id === conversationId).length,
    0,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  reorderImpl = async () => ({ data: undefined, response: { ok: true } });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pin/unpin placement", () => {
  test("pinning moves the row before the request resolves", async () => {
    const pending = deferred<{ data: undefined; response: { ok: boolean } }>();
    reorderImpl = () => pending.promise;
    const { result, client } = setup([
      [SLACK, [SLACK_ROW]],
      [PINNED, []],
    ]);

    await act(async () => {
      result.current.handleTogglePinConversation(SLACK_ROW);
    });

    // Still in flight: this is the whole point, the sidebar must already be
    // correct rather than correct-once-two-refetches-land.
    expect(idsIn(client, PINNED)).toEqual(["c1"]);
    expect(idsIn(client, SLACK)).toEqual([]);
    expect(copies(client, "c1")).toBe(1);

    await act(async () => {
      pending.resolve({ data: undefined, response: { ok: true } });
    });
  });

  test("a failed pin puts the row back in the section it left", async () => {
    reorderImpl = async () => {
      throw new Error("nope");
    };
    const { result, client } = setup([
      [SLACK, [SLACK_ROW]],
      [PINNED, []],
    ]);

    await act(async () => {
      result.current.handleTogglePinConversation(SLACK_ROW);
    });

    await waitFor(() => {
      expect(idsIn(client, SLACK)).toEqual(["c1"]);
    });
    expect(idsIn(client, PINNED)).toEqual([]);
    expect(copies(client, "c1")).toBe(1);
  });

  test("unpinning returns the row to its channel section", async () => {
    const pinnedRow: Conversation = {
      ...SLACK_ROW,
      isPinned: true,
      groupId: "system:pinned",
    };
    const { result, client } = setup([
      [SLACK, []],
      [PINNED, [pinnedRow]],
    ]);

    await act(async () => {
      result.current.handleTogglePinConversation(pinnedRow);
    });

    expect(idsIn(client, SLACK)).toEqual(["c1"]);
    expect(idsIn(client, PINNED)).toEqual([]);
    expect(copies(client, "c1")).toBe(1);
  });

  test("settling does not invalidate the foreground list", async () => {
    /* The foreground list drains every page serially, so invalidating it on
       a pin re-reads the whole sidebar to learn one row's group. Nothing
       about it is stale: the optimistic write already patched the row in
       place, and the sidebar still reads it to decide which sections exist. */
    const { result, client } = setup([
      [SLACK, [SLACK_ROW]],
      [PINNED, []],
    ]);

    await act(async () => {
      result.current.handleTogglePinConversation(SLACK_ROW);
    });

    await waitFor(() => {
      expect(
        client.getQueryState(sectionConversationsQueryKey(ASSISTANT_ID, PINNED))
          ?.isInvalidated,
      ).toBe(true);
    });
    expect(
      client.getQueryState(conversationsQueryKey(ASSISTANT_ID))?.isInvalidated,
    ).toBe(false);
  });
});
