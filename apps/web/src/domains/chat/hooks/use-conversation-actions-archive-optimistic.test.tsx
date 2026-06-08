/**
 * Tests for the optimistic archive / unarchive paths in
 * `useConversationActions`.
 *
 * **The bug these tests guard against.** Archive used to await the network
 * call (and a follow-up conversation-list refresh) before patching the
 * TanStack Query cache, which meant the archived row stayed visible in
 * the sidebar for the full duration of the round trip. Unarchive had the
 * inverse problem — patched only after the API resolved. Both paths now
 * use the TanStack-recommended `useMutation` lifecycle with optimistic
 * updates in `onMutate`, snapshot-based rollback in `onError`, and
 * full cache invalidation in `onSettled`.
 *
 * Each `useMutation` follows:
 *   `onMutate`  → `cancelQueries`, snapshot, optimistic `setQueryData`
 *   `onError`   → restore snapshot
 *   `onSettled` → `invalidateQueries` (refetch from server)
 *
 * The `mutate()` call is fire-and-forget; `onMutate` runs as a microtask
 * before `mutationFn` starts. Tests use the `act()` / deferred pattern:
 *   1. Wrap the handler call in `await act(async () => { handle(...) })`
 *      to flush `onMutate` microtasks.
 *   2. Assert the cache reflects the optimistic value.
 *   3. Resolve the deferred API mock inside a second `act()`.
 *   4. Assert the post-resolution state (or rollback, for error tests).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import * as sdkGen from "@/generated/daemon/sdk.gen";
import type { Conversation } from "@/types/conversation-types";
import {
  archivedConversationsQueryKey,
  conversationsQueryKey,
} from "@/lib/sync/query-tags";

// ---------------------------------------------------------------------------
// Module mocks. Archive/unarchive impls are pulled from module-level holders
// so each test can inject a deferred or failing implementation. The mock
// spreads the real module so unrelated consumers in the import graph keep
// working — we only override the functions whose timing the hook controls.
// ---------------------------------------------------------------------------

type ArchiveImpl = (opts: { path: { assistant_id: string; id: string }; throwOnError: boolean }) => Promise<{ data: undefined; response: { ok: boolean } }>;

let archiveImpl: ArchiveImpl = async () => ({ data: undefined, response: { ok: true } });
let unarchiveImpl: ArchiveImpl = async () => ({ data: undefined, response: { ok: true } });

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  conversationsByIdArchivePost: (opts: { path: { assistant_id: string; id: string }; throwOnError: boolean }) =>
    archiveImpl(opts),
  conversationsByIdUnarchivePost: (opts: { path: { assistant_id: string; id: string }; throwOnError: boolean }) =>
    unarchiveImpl(opts),
}));

// Stub haptics — Capacitor's web shim works fine in a node test environment,
// but stubbing avoids the unrelated side-effect noise.
mock.module("@/utils/haptics", () => ({
  haptic: { medium: () => {}, light: () => {} },
}));

// Sentry captures from the error path — stub so test failures don't get
// confused with real exception reports.
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

function seedClient(conversations: Conversation[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(conversationsQueryKey(ASSISTANT_ID), conversations);
  return client;
}

function setupHook(opts: {
  conversations: Conversation[];
  activeConversationId?: string | null;
}) {
  const client = seedClient(opts.conversations);
  const switchCalls: string[] = [];
  const startNewCalls: number[] = [];

  const { result } = renderHook(
    () =>
      useConversationActions({
        assistantId: ASSISTANT_ID,
        activeConversationId: opts.activeConversationId ?? null,
        conversations: opts.conversations,
        switchConversation: (conversationId: string) => {
          switchCalls.push(conversationId);
        },
        startNewConversation: () => {
          startNewCalls.push(Date.now());
        },
        prePinGroupIdsRef: { current: new Map() },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    },
  );

  return {
    result,
    client,
    switchCalls,
    startNewCalls,
  };
}

function readArchived(
  client: QueryClient,
  conversationId: string,
): number | undefined {
  const list = client.getQueryData<Conversation[]>(
    conversationsQueryKey(ASSISTANT_ID),
  );
  return list?.find((c) => c.conversationId === conversationId)?.archivedAt;
}

/** Manually-controlled promise for staging in-flight API states in tests. */
function deferred<T = { data: undefined; response: { ok: boolean } }>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  archiveImpl = async () => ({ data: undefined, response: { ok: true } });
  unarchiveImpl = async () => ({ data: undefined, response: { ok: true } });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

describe("handleArchiveConversation — optimistic update", () => {
  test("patches archivedAt in the cache before the API resolves", async () => {
    const conv = makeConversation({ conversationId: "conv-1" });
    const { result, client } = setupHook({ conversations: [conv] });

    const d = deferred();
    archiveImpl = () => d.promise;

    await act(async () => {
      result.current.handleArchiveConversation(conv);
    });

    // The optimistic patch is the whole point — assert it lands without
    // waiting for the network round trip to complete.
    expect(readArchived(client, "conv-1")).toEqual(expect.any(Number));

    await act(async () => {
      d.resolve({ data: undefined, response: { ok: true } });
    });
  });

  test("switches to the next foreground conversation before the API resolves", async () => {
    const archived = makeConversation({ conversationId: "active" });
    const next = makeConversation({ conversationId: "next" });
    const { result, switchCalls } = setupHook({
      conversations: [archived, next],
      activeConversationId: "active",
    });

    const d = deferred();
    archiveImpl = () => d.promise;

    await act(async () => {
      result.current.handleArchiveConversation(archived);
    });

    // The switch fires synchronously, before the network round trip.
    expect(switchCalls).toEqual(["next"]);

    await act(async () => {
      d.resolve({ data: undefined, response: { ok: true } });
    });
  });

  test("rolls back the cache patch when the API rejects", async () => {
    const conv = makeConversation({ conversationId: "conv-1" });
    const { result, client } = setupHook({ conversations: [conv] });

    archiveImpl = async () => {
      throw new Error("network failure");
    };

    await act(async () => {
      result.current.handleArchiveConversation(conv);
    });

    // onError restores the snapshot — `archivedAt` reverts to `undefined`
    // so the row reappears in the active sidebar.
    await waitFor(() => {
      expect(readArchived(client, "conv-1")).toBeUndefined();
    });
  });

  test("invalidates conversation caches on success", async () => {
    const conv = makeConversation({ conversationId: "conv-1" });
    const { result, client } = setupHook({ conversations: [conv] });

    // Seed the archived cache — onSettled should invalidate it.
    client.setQueryData(archivedConversationsQueryKey(ASSISTANT_ID), []);
    const beforeState = client.getQueryState(
      archivedConversationsQueryKey(ASSISTANT_ID),
    );
    expect(beforeState?.isInvalidated).toBe(false);

    await act(async () => {
      result.current.handleArchiveConversation(conv);
    });

    await waitFor(() => {
      const afterState = client.getQueryState(
        archivedConversationsQueryKey(ASSISTANT_ID),
      );
      expect(afterState?.isInvalidated).toBe(true);
    });
  });

  test("invalidates conversation caches even on error", async () => {
    const conv = makeConversation({ conversationId: "conv-1" });
    const { result, client } = setupHook({ conversations: [conv] });

    client.setQueryData(archivedConversationsQueryKey(ASSISTANT_ID), []);

    archiveImpl = async () => {
      throw new Error("network failure");
    };

    await act(async () => {
      result.current.handleArchiveConversation(conv);
    });

    // onSettled runs on both success and error — cache is invalidated so
    // TanStack Query refetches the server-authoritative state.
    await waitFor(() => {
      const afterState = client.getQueryState(
        archivedConversationsQueryKey(ASSISTANT_ID),
      );
      expect(afterState?.isInvalidated).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Unarchive
// ---------------------------------------------------------------------------

describe("handleUnarchiveConversation — optimistic update", () => {
  test("clears archivedAt in the cache before the API resolves", async () => {
    const conv = makeConversation({
      conversationId: "conv-1",
      archivedAt: 1234,
    });
    const { result, client } = setupHook({ conversations: [conv] });

    const d = deferred();
    unarchiveImpl = () => d.promise;

    await act(async () => {
      result.current.handleUnarchiveConversation(conv);
    });

    // The optimistic clear lands before the API resolves —
    // mirroring the archive path.
    await waitFor(() => {
      expect(readArchived(client, "conv-1")).toBeUndefined();
    });

    await act(async () => {
      d.resolve({ data: undefined, response: { ok: true } });
    });
  });

  test("rolls back to the prior archivedAt when the API rejects", async () => {
    const conv = makeConversation({
      conversationId: "conv-1",
      archivedAt: 1234,
    });
    const { result, client } = setupHook({ conversations: [conv] });

    unarchiveImpl = async () => {
      throw new Error("network failure");
    };

    await act(async () => {
      result.current.handleUnarchiveConversation(conv);
    });

    // The original timestamp is restored — the row re-archives in the UI.
    await waitFor(() => {
      expect(readArchived(client, "conv-1")).toBe(1234);
    });
  });

  test("invalidates conversation caches on success", async () => {
    const conv = makeConversation({
      conversationId: "conv-1",
      archivedAt: 1234,
    });
    const { result, client } = setupHook({ conversations: [conv] });

    client.setQueryData(archivedConversationsQueryKey(ASSISTANT_ID), [conv]);
    const beforeState = client.getQueryState(
      archivedConversationsQueryKey(ASSISTANT_ID),
    );
    expect(beforeState?.isInvalidated).toBe(false);

    await act(async () => {
      result.current.handleUnarchiveConversation(conv);
    });

    await waitFor(() => {
      const afterState = client.getQueryState(
        archivedConversationsQueryKey(ASSISTANT_ID),
      );
      expect(afterState?.isInvalidated).toBe(true);
    });
  });

  test("invalidates conversation caches even on error", async () => {
    const conv = makeConversation({
      conversationId: "conv-1",
      archivedAt: 1234,
    });
    const { result, client } = setupHook({ conversations: [conv] });

    client.setQueryData(archivedConversationsQueryKey(ASSISTANT_ID), [conv]);

    unarchiveImpl = async () => {
      throw new Error("network failure");
    };

    await act(async () => {
      result.current.handleUnarchiveConversation(conv);
    });

    await waitFor(() => {
      const afterState = client.getQueryState(
        archivedConversationsQueryKey(ASSISTANT_ID),
      );
      expect(afterState?.isInvalidated).toBe(true);
    });
  });
});
