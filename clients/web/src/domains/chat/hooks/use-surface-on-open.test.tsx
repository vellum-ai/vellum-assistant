/**
 * Tests for surfacing a background/scheduled run on open.
 *
 * The invariant: opening is the promotion. An unsurfaced background run
 * whose conversation becomes active fires exactly one surface POST and
 * lands in the foreground cache with the server's `surfacedAt`; everything
 * already visible (surfaced, standard, pinned, grouped) fires nothing.
 *
 * Server-first means failure needs no rollback, only a released guard so
 * the next effect evaluation retries.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import type * as ConversationsApi from "@/domains/chat/api/conversations";
import type { Conversation } from "@/types/conversation-types";
import { conversationsQueryKey } from "@/utils/conversation-list-fetchers";

const surfaceCalls: Array<{ assistantId: string; conversationId: string }> = [];
let surfaceImpl: (conversationId: string) => Promise<number> = async () => 4242;

mock.module(
  "@/domains/chat/api/conversations",
  (): Partial<typeof ConversationsApi> => ({
    surfaceConversation: async (
      assistantId: string,
      conversationId: string,
    ) => {
      surfaceCalls.push({ assistantId, conversationId });
      return surfaceImpl(conversationId);
    },
  }),
);

mock.module("@sentry/react", () => ({
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
}));

const { useSurfaceOnOpen } =
  await import("@/domains/chat/hooks/use-surface-on-open");

const ASSISTANT_ID = "asst-1";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return { conversationId: "bg1", lastMessageAt: 1000, ...overrides };
}

function renderSurfaceOnOpen(
  client: QueryClient,
  activeConversation: Conversation | undefined,
) {
  return renderHook(
    (props: { activeConversation: Conversation | undefined }) =>
      useSurfaceOnOpen({
        assistantId: ASSISTANT_ID,
        assistantStateKind: "active",
        activeConversationId: props.activeConversation?.conversationId ?? null,
        activeConversation: props.activeConversation,
      }),
    {
      initialProps: { activeConversation },
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    },
  );
}

beforeEach(() => {
  surfaceCalls.length = 0;
  surfaceImpl = async () => 4242;
});

afterEach(() => {
  cleanup();
});

describe("useSurfaceOnOpen", () => {
  test("opening an unsurfaced background run surfaces it once", async () => {
    const client = new QueryClient();
    const bg = conversation({ conversationType: "background" });
    client.setQueryData<Conversation[]>(
      conversationsQueryKey(ASSISTANT_ID),
      [],
    );

    const { rerender } = renderSurfaceOnOpen(client, bg);

    await waitFor(() => {
      expect(surfaceCalls).toEqual([
        { assistantId: ASSISTANT_ID, conversationId: "bg1" },
      ]);
    });
    await waitFor(() => {
      expect(
        client
          .getQueryData<Conversation[]>(conversationsQueryKey(ASSISTANT_ID))
          ?.map((c) => c.surfacedAt),
      ).toEqual([4242]);
    });

    // A re-render with the same row must not fire again.
    await act(async () => {
      rerender({ activeConversation: bg });
    });
    expect(surfaceCalls).toHaveLength(1);
  });

  test("an already-surfaced run fires nothing", async () => {
    const client = new QueryClient();
    const { rerender } = renderSurfaceOnOpen(
      client,
      conversation({ conversationType: "background", surfacedAt: 7 }),
    );
    rerender({
      activeConversation: conversation({
        conversationType: "background",
        surfacedAt: 7,
      }),
    });

    expect(surfaceCalls).toHaveLength(0);
  });

  test("a standard conversation fires nothing", () => {
    const client = new QueryClient();
    renderSurfaceOnOpen(client, conversation({}));

    expect(surfaceCalls).toHaveLength(0);
  });

  test("a pinned or filed run fires nothing", () => {
    // Pinning or filing already made the row visible; there is nothing to
    // promote, and the placement write already stamped surfaced_at.
    const client = new QueryClient();
    renderSurfaceOnOpen(
      client,
      conversation({ conversationType: "background", isPinned: true }),
    );
    renderSurfaceOnOpen(
      client,
      conversation({
        conversationId: "bg2",
        conversationType: "scheduled",
        groupId: "group-uuid",
      }),
    );

    expect(surfaceCalls).toHaveLength(0);
  });

  test("a failed surface leaves caches untouched and retries on the next open", async () => {
    const client = new QueryClient();
    client.setQueryData<Conversation[]>(
      conversationsQueryKey(ASSISTANT_ID),
      [],
    );
    surfaceImpl = async () => {
      throw new Error("surface failed");
    };
    const bg = conversation({ conversationType: "background" });

    const { rerender } = renderSurfaceOnOpen(client, bg);
    await waitFor(() => {
      expect(surfaceCalls).toHaveLength(1);
    });
    expect(
      client.getQueryData<Conversation[]>(conversationsQueryKey(ASSISTANT_ID)),
    ).toEqual([]);

    // Guard released: a fresh evaluation (new row identity) tries again.
    surfaceImpl = async () => 4242;
    await act(async () => {
      rerender({
        activeConversation: conversation({ conversationType: "background" }),
      });
    });
    await waitFor(() => {
      expect(surfaceCalls).toHaveLength(2);
    });
  });

  test("one run's settle does not release another run's in-flight guard", async () => {
    /* Open A, then open B while A is still out. A settling must delete only
       its own guard entry: releasing B's would let B's next identity churn
       fire a duplicate promotion for a run already being promoted. */
    const client = new QueryClient();
    client.setQueryData<Conversation[]>(
      conversationsQueryKey(ASSISTANT_ID),
      [],
    );
    const resolvers = new Map<string, (at: number) => void>();
    surfaceImpl = (conversationId) =>
      new Promise<number>((resolve) => {
        resolvers.set(conversationId, resolve);
      });

    const runA = conversation({
      conversationId: "run-a",
      conversationType: "background",
    });
    const { rerender } = renderSurfaceOnOpen(client, runA);
    await waitFor(() => {
      expect(surfaceCalls).toHaveLength(1);
    });

    rerender({
      activeConversation: conversation({
        conversationId: "run-b",
        conversationType: "background",
      }),
    });
    await waitFor(() => {
      expect(surfaceCalls).toHaveLength(2);
    });

    // A settles while B is still in flight.
    await act(async () => {
      resolvers.get("run-a")!(4242);
    });

    // B's identity churns (a cache write elsewhere): still guarded.
    rerender({
      activeConversation: conversation({
        conversationId: "run-b",
        conversationType: "background",
      }),
    });
    expect(surfaceCalls).toHaveLength(2);

    await act(async () => {
      resolvers.get("run-b")!(4242);
    });
  });

  test("a pending request blocks a duplicate while prop identity churns", async () => {
    const client = new QueryClient();
    client.setQueryData<Conversation[]>(
      conversationsQueryKey(ASSISTANT_ID),
      [],
    );
    let resolveSurface!: (at: number) => void;
    surfaceImpl = () =>
      new Promise<number>((resolve) => {
        resolveSurface = resolve;
      });
    const bg = conversation({ conversationType: "background" });

    const { rerender } = renderSurfaceOnOpen(client, bg);
    await waitFor(() => {
      expect(surfaceCalls).toHaveLength(1);
    });

    // A new object for the same conversation (a cache write elsewhere) must
    // not start a second request while the first is in flight.
    rerender({
      activeConversation: conversation({ conversationType: "background" }),
    });
    expect(surfaceCalls).toHaveLength(1);

    await act(async () => {
      resolveSurface(4242);
    });
  });
});
