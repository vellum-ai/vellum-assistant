/**
 * The daemon preconditions shared by every query in `conversation-queries.ts`.
 *
 * These hooks share their query keys across many call sites, and TanStack
 * Query fetches when any observer is enabled, so the gate only holds if it
 * lives inside the hooks rather than at the call sites. That is what these
 * cover: not whether the pod-health predicate is correct (see
 * `assistant/operational-status.test.tsx`), but whether the hooks consult it
 * at all, and whether a call site passing `enabled: true` can defeat it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { GroupsGetResponse } from "@/generated/daemon/types.gen";

const conversationsGetMock = mock(async () => ({
  data: { conversations: [], hasMore: false },
  error: undefined,
  response: new Response(null, { status: 200 }),
}));

interface GroupsGetResult {
  data: GroupsGetResponse;
  error: undefined;
  response: Response;
}

function groupsOk(groups: GroupsGetResponse["groups"] = []): GroupsGetResult {
  return {
    data: { groups },
    error: undefined,
    response: new Response(null, { status: 200 }),
  };
}

const groupsGetMock = mock(async (): Promise<GroupsGetResult> => groupsOk());

let podIsServing = true;
let orgIsReady = true;

/* Spread over the real module rather than replacing it: the generated SDK is a
   single barrel that unrelated modules in this import graph also pull from, and
   a bare object drops every export this file does not name. */
const realDaemonSdk = await import("@/generated/daemon/sdk.gen");

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...realDaemonSdk,
  conversationsGet: conversationsGetMock,
  groupsGet: groupsGetMock,
}));

mock.module("@/assistant/operational-status", () => ({
  useAssistantIsServing: () => podIsServing,
}));

/* A completed drain posts to the telemetry ingest, which has no listener here
   and surfaces as an unhandled ECONNREFUSED after the assertions. */
mock.module("@/lib/telemetry/client-perf", () => ({
  emitClientPerfEvent: () => {},
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgIsReady,
}));

const {
  useConversationGroupsQuery,
  useConversationListQuery,
  useSectionConversationListQuery,
} = await import("@/hooks/conversation-queries");
const { conversationListQueryKey } =
  await import("@/utils/conversation-list-keys");

const ASSISTANT_ID = "asst-1";

function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: makeQueryClient() },
    children,
  );
}

/** A wrapper over one client the test can inspect afterwards. */
function wrapperFor(queryClient: QueryClient) {
  return function InspectableWrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  conversationsGetMock.mockClear();
  groupsGetMock.mockClear();
  groupsGetMock.mockImplementation(async () => groupsOk());
  podIsServing = true;
  orgIsReady = true;
});

afterEach(() => {
  cleanup();
});

describe("conversation queries · daemon gate", () => {
  test("fetches when the pod is serving", async () => {
    renderHook(() => useConversationListQuery(ASSISTANT_ID), { wrapper });

    await waitFor(() => {
      expect(conversationsGetMock).toHaveBeenCalled();
    });
  });

  test("does not fetch while the pod is not serving", async () => {
    // A waking pod 503s every request, and the list query has a bounded retry
    // budget. Spending it inside the wake window leaves the query in a
    // terminal error state that nothing clears, which renders as an assistant
    // with no conversations.
    podIsServing = false;

    renderHook(() => useConversationListQuery(ASSISTANT_ID), { wrapper });
    await settle();

    expect(conversationsGetMock).not.toHaveBeenCalled();
  });

  test("a call site passing enabled cannot open the gate itself", async () => {
    // Several call sites mount this query with a hardcoded `true`. Since every
    // observer shares one query key, a gate applied at the call sites would be
    // defeated by whichever mount passed no gate of its own.
    podIsServing = false;

    renderHook(() => useConversationListQuery(ASSISTANT_ID, true), { wrapper });
    await settle();

    expect(conversationsGetMock).not.toHaveBeenCalled();
  });

  test("fetches once a waking pod comes up", async () => {
    // The recovery edge: flipping `enabled` back to true is what makes
    // TanStack Query re-issue a fetch that was never allowed to run.
    podIsServing = false;

    const { rerender } = renderHook(
      () => useConversationListQuery(ASSISTANT_ID),
      { wrapper },
    );
    await settle();
    expect(conversationsGetMock).not.toHaveBeenCalled();

    podIsServing = true;
    rerender();

    await waitFor(() => {
      expect(conversationsGetMock).toHaveBeenCalled();
    });
  });

  test("still honors org readiness", async () => {
    // The gate is an AND of both preconditions, so the pod being up must not
    // let a request through before the org header is available.
    orgIsReady = false;

    renderHook(() => useConversationListQuery(ASSISTANT_ID), { wrapper });
    await settle();

    expect(conversationsGetMock).not.toHaveBeenCalled();
  });
});

describe("section list query · no filter, no query", () => {
  test("a null filter mounts nothing: no cache entry, no request", async () => {
    /* Every filter names a real cache under the generated key, the empty
       filter included, so the only honest answer for a section with no
       server filter is to observe nothing at all. In particular nothing may
       sit on the foreground list's key. */
    const queryClient = makeQueryClient();
    renderHook(() => useSectionConversationListQuery(ASSISTANT_ID, null), {
      wrapper: wrapperFor(queryClient),
    });
    await settle();

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(
      queryClient.getQueryCache().find({
        queryKey: conversationListQueryKey(ASSISTANT_ID),
        exact: true,
      }),
    ).toBeUndefined();
    expect(conversationsGetMock).not.toHaveBeenCalled();
  });

  test("a null filter reads as nothing to show", async () => {
    const { result } = renderHook(
      () => useSectionConversationListQuery(ASSISTANT_ID, null),
      { wrapper },
    );
    await settle();

    expect(result.current.conversations).toEqual([]);
    expect(result.current.hasData).toBe(false);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  test("a filter mounts exactly its own query", async () => {
    const queryClient = makeQueryClient();
    const filter = { groupId: "system:pinned" };
    renderHook(() => useSectionConversationListQuery(ASSISTANT_ID, filter), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => {
      expect(conversationsGetMock).toHaveBeenCalledTimes(1);
    });

    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toEqual([conversationListQueryKey(ASSISTANT_ID, filter)]);
  });
});

/* The groups query serves the same `[]` fallback in three different
   situations, and a consumer that writes the groups somewhere durable (the iOS
   widget snapshot, whose rows carry group names as subtitles) has to tell a
   genuinely group-less assistant apart from the other two. `isLoading` cannot:
   it is false both for a query that is gated and for one that has failed. */
describe("groups query · resolution state", () => {
  test("a gated query reads as pending, never as loaded", async () => {
    podIsServing = false;

    const { result } = renderHook(
      () => useConversationGroupsQuery(ASSISTANT_ID),
      { wrapper },
    );
    await settle();

    expect(groupsGetMock).not.toHaveBeenCalled();
    expect(result.current.conversationGroups).toEqual([]);
    expect(result.current.isPending).toBe(true);
    expect(result.current.isError).toBe(false);
    // The trap this guards: nothing is in flight, so `isLoading` reports "not
    // loading" for a query that has never run and has no answer to give.
    expect(result.current.isLoading).toBe(false);
  });

  test("a terminal error reads as failed, never as loaded", async () => {
    groupsGetMock.mockImplementation(async () => {
      throw new Error("groups unavailable");
    });

    const { result } = renderHook(
      () => useConversationGroupsQuery(ASSISTANT_ID),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.conversationGroups).toEqual([]);
    expect(result.current.isPending).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  test("a successful fetch reads as resolved", async () => {
    groupsGetMock.mockImplementation(async () =>
      groupsOk([
        { id: "g1", name: "First", sortPosition: 0, isSystemGroup: false },
      ]),
    );

    const { result } = renderHook(
      () => useConversationGroupsQuery(ASSISTANT_ID),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.conversationGroups).toHaveLength(1);
    });
    expect(result.current.isPending).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  test("an empty list from a successful fetch still reads as resolved", async () => {
    // The case the flag exists to separate from the other two: an assistant
    // with no groups answers `[]`, and that answer is trustworthy.
    const { result } = renderHook(
      () => useConversationGroupsQuery(ASSISTANT_ID),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
    expect(result.current.conversationGroups).toEqual([]);
    expect(result.current.isError).toBe(false);
  });
});
