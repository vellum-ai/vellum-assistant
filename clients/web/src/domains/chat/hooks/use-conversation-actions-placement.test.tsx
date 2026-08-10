/**
 * Tests for pin/unpin as a *placement*: the section caches, not the fields.
 *
 * Every sidebar section fetches its own rows through a server filter
 * (LUM-2443), so a section's membership is the contents of its cache entry
 * rather than something the client derives. Two invariants follow, and these
 * are what the assertions are shaped around:
 *
 * 1. A conversation appears in exactly one section, never twice. Counting
 *    copies across every seeded section is the only assertion that catches a
 *    row which reaches its destination without leaving its origin; "Pinned
 *    contains the row" holds either way.
 * 2. The move lands before the request resolves. A placement that waits on the
 *    network shows the row in two sections for the length of the round trip,
 *    since each section corrects itself on its own refetch.
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

  test("a failed move leaves a newer move of the same row alone", async () => {
    /* Two moves of one conversation overlap whenever the second starts before
       the first settles, and both write the same fields. A rollback that fires
       regardless of what happened since would put the row back where it sat
       before the *older* move, discarding a placement the user made later. */
    const first = deferred<{ data: undefined; response: { ok: boolean } }>();
    let call = 0;
    reorderImpl = () => {
      call += 1;
      return call === 1
        ? first.promise
        : Promise.resolve({ data: undefined, response: { ok: true } });
    };

    const { result, client } = setup([
      [SLACK, [SLACK_ROW]],
      [PINNED, []],
    ]);

    // Move A: pin. Still in flight.
    await act(async () => {
      result.current.handleTogglePinConversation(SLACK_ROW);
    });
    expect(idsIn(client, PINNED)).toEqual(["c1"]);

    // Move B: unpin the row A just placed, before A has settled.
    const pinnedRow: Conversation = {
      ...SLACK_ROW,
      isPinned: true,
      groupId: "system:pinned",
    };
    await act(async () => {
      result.current.handleTogglePinConversation(pinnedRow);
    });
    expect(idsIn(client, SLACK)).toEqual(["c1"]);

    // A now fails. Its rollback would restore the pre-A state, which is the
    // placement B has already replaced.
    await act(async () => {
      first.reject(new Error("nope"));
      await first.promise.catch(() => {});
    });

    await waitFor(() => {
      expect(idsIn(client, SLACK)).toEqual(["c1"]);
    });
    expect(idsIn(client, PINNED)).toEqual([]);
    expect(copies(client, "c1")).toBe(1);
  });

  test("a settled move does not free its ownership claim for reuse", async () => {
    /* A owns a token, B takes a newer one and settles first. If the next
       token were derived from what the conversation currently holds rather
       than from a counter that only increases, C would reissue A's token and
       A's failure would then pass its ownership check against C's write. */
    const a = deferred<{ data: undefined; response: { ok: boolean } }>();
    let call = 0;
    reorderImpl = () => {
      call += 1;
      return call === 1
        ? a.promise
        : Promise.resolve({ data: undefined, response: { ok: true } });
    };

    const { result, client } = setup([
      [SLACK, [SLACK_ROW]],
      [PINNED, []],
    ]);

    // A: pin, left in flight.
    await act(async () => {
      result.current.handleTogglePinConversation(SLACK_ROW);
    });
    const pinnedRow: Conversation = {
      ...SLACK_ROW,
      isPinned: true,
      groupId: "system:pinned",
    };

    // B: unpin, settles immediately and releases the conversation's entry.
    await act(async () => {
      result.current.handleTogglePinConversation(pinnedRow);
    });
    await waitFor(() => {
      expect(idsIn(client, SLACK)).toEqual(["c1"]);
    });

    // C: pin again, on a freshly empty entry.
    await act(async () => {
      result.current.handleTogglePinConversation(SLACK_ROW);
    });
    expect(idsIn(client, PINNED)).toEqual(["c1"]);

    // A finally fails. It must not undo C.
    await act(async () => {
      a.reject(new Error("nope"));
      await a.promise.catch(() => {});
    });

    await waitFor(() => {
      expect(idsIn(client, PINNED)).toEqual(["c1"]);
    });
    expect(idsIn(client, SLACK)).toEqual([]);
    expect(copies(client, "c1")).toBe(1);
  });

  test("an older move does not refetch while a newer one is in flight", async () => {
    /* A refetch started by a superseded move brings back server state the
       newer move has not been applied to yet, and it lands on top of the
       newer optimistic write: the cancel that guards an optimistic write runs
       when that write is made, so it cannot reach a request started later. */
    const b = deferred<{ data: undefined; response: { ok: boolean } }>();
    let call = 0;
    reorderImpl = () => {
      call += 1;
      return call === 1
        ? Promise.resolve({ data: undefined, response: { ok: true } })
        : b.promise;
    };

    const { result, client } = setup([
      [SLACK, [SLACK_ROW]],
      [PINNED, []],
    ]);
    const pinnedKey = sectionConversationsQueryKey(ASSISTANT_ID, PINNED);

    // A: pin. Its request resolves, but B starts before A settles.
    await act(async () => {
      result.current.handleTogglePinConversation(SLACK_ROW);
      result.current.handleTogglePinConversation({
        ...SLACK_ROW,
        isPinned: true,
        groupId: "system:pinned",
      });
    });

    // A has settled and B is still pending: nothing is invalidated yet,
    // because only the latest placement reconciles.
    expect(client.getQueryState(pinnedKey)?.isInvalidated).toBe(false);

    await act(async () => {
      b.resolve({ data: undefined, response: { ok: true } });
      await b.promise;
    });

    // Once B settles it reconciles, covering the sections A touched too.
    await waitFor(() => {
      expect(client.getQueryState(pinnedKey)?.isInvalidated).toBe(true);
    });
    expect(idsIn(client, SLACK)).toEqual(["c1"]);
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
