/**
 * Tests for the optimistic archive / unarchive paths in
 * `useConversationActions`.
 *
 * **The bug these tests guard against.** Archive used to await the network
 * call (and a follow-up conversation-list refresh) before patching the
 * TanStack Query cache, which meant the archived row stayed visible in
 * the sidebar for the full duration of the round trip. Unarchive had the
 * inverse problem — patched only after the API resolved. Both paths now
 * patch the cache up front and roll back on failure.
 *
 * The hook fires the cache patch synchronously, before the first `await`,
 * so each test:
 *   1. Wraps the action call in `act(() => { promise = handle(...) })`
 *      without awaiting (so we can observe the in-flight state).
 *   2. Asserts the cache reflects the optimistic value.
 *   3. Resolves the deferred API mock and awaits the captured promise.
 *   4. Asserts the post-resolution state (or rollback, for error tests).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import * as conversationsApi from "@/domains/chat/api/conversations.js";
import type { Conversation } from "@/domains/chat/api/conversations.js";
import { chatContextQueryKey } from "@/lib/sync/query-tags.js";

// ---------------------------------------------------------------------------
// Module mocks. Archive/unarchive impls are pulled from module-level holders
// so each test can inject a deferred or failing implementation. The mock
// spreads the real module so unrelated consumers in the import graph (group
// CRUD, sub-agent fetch, conversation-list query, etc.) keep working — we
// only override the two functions whose timing the hook is responsible for.
// ---------------------------------------------------------------------------

type ApiImpl = (assistantId: string, conversationId: string) => Promise<void>;

let archiveImpl: ApiImpl = async () => {};
let unarchiveImpl: ApiImpl = async () => {};

mock.module("@/domains/chat/api/conversations.js", () => ({
  ...conversationsApi,
  archiveConversation: (assistantId: string, conversationId: string) =>
    archiveImpl(assistantId, conversationId),
  unarchiveConversation: (assistantId: string, conversationId: string) =>
    unarchiveImpl(assistantId, conversationId),
}));

// Stub haptics — Capacitor's web shim works fine in a node test environment,
// but stubbing avoids the unrelated side-effect noise.
mock.module("@/utils/haptics.js", () => ({
  haptic: { medium: () => {}, light: () => {} },
}));

// Sentry captures from the error path — stub so test failures don't get
// confused with real exception reports.
mock.module("@sentry/react", () => ({
  captureException: () => {},
}));

const { useConversationActions } = await import(
  "@/domains/conversations/use-conversation-actions.js"
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
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  client.setQueryData(chatContextQueryKey(ASSISTANT_ID), {
    conversations,
    conversationGroups: [],
  });
  return client;
}

function setupHook(opts: {
  conversations: Conversation[];
  activeKey?: string | null;
}) {
  const client = seedClient(opts.conversations);
  const switchCalls: string[] = [];
  const startNewCalls: number[] = [];
  let refreshCalls = 0;

  const { result } = renderHook(
    () =>
      useConversationActions({
        assistantId: ASSISTANT_ID,
        activeConversationKey: opts.activeKey ?? null,
        conversations: opts.conversations,
        refreshConversations: async () => {
          refreshCalls += 1;
        },
        switchConversation: (key: string) => {
          switchCalls.push(key);
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
    getRefreshCalls: () => refreshCalls,
  };
}

function readArchived(
  client: QueryClient,
  key: string,
): number | undefined {
  const ctx = client.getQueryData<{ conversations: Conversation[] }>(
    chatContextQueryKey(ASSISTANT_ID),
  );
  return ctx?.conversations.find((c) => c.conversationId === key)?.archivedAt;
}

/** Manually-controlled promise for staging in-flight API states in tests. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  archiveImpl = async () => {};
  unarchiveImpl = async () => {};
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

    let archivePromise: Promise<void> | undefined;
    act(() => {
      archivePromise = result.current.handleArchiveConversation(conv);
    });

    // The optimistic patch is the whole point — assert it lands without
    // waiting for the network round trip to complete.
    expect(readArchived(client, "conv-1")).toEqual(expect.any(Number));

    d.resolve(undefined);
    await archivePromise;

    // Post-resolution the row stays archived; in production this value
    // gets replaced by the server-authoritative timestamp via
    // `refreshConversations()`.
    expect(readArchived(client, "conv-1")).toEqual(expect.any(Number));
  });

  test("switches to the next foreground conversation before the API resolves", async () => {
    const archived = makeConversation({ conversationId: "active" });
    const next = makeConversation({ conversationId: "next" });
    const { result, switchCalls } = setupHook({
      conversations: [archived, next],
      activeKey: "active",
    });

    const d = deferred();
    archiveImpl = () => d.promise;

    let archivePromise: Promise<void> | undefined;
    act(() => {
      archivePromise = result.current.handleArchiveConversation(archived);
    });

    // The switch fires synchronously, before the network round trip.
    expect(switchCalls).toEqual(["next"]);

    d.resolve(undefined);
    await archivePromise;
  });

  test("rolls back the cache patch when the API rejects", async () => {
    const conv = makeConversation({ conversationId: "conv-1" });
    const { result, client } = setupHook({ conversations: [conv] });

    archiveImpl = async () => {
      throw new Error("network failure");
    };

    await act(async () => {
      await result.current.handleArchiveConversation(conv);
    });

    // Rollback restored `archivedAt` to its prior `undefined` value, so
    // the row reappears in the active sidebar.
    expect(readArchived(client, "conv-1")).toBeUndefined();
  });

  test("calls refreshConversations once on success", async () => {
    const conv = makeConversation({ conversationId: "conv-1" });
    const { result, getRefreshCalls } = setupHook({ conversations: [conv] });

    await act(async () => {
      await result.current.handleArchiveConversation(conv);
    });

    expect(getRefreshCalls()).toBe(1);
  });

  test("does not refresh when the archive API fails", async () => {
    const conv = makeConversation({ conversationId: "conv-1" });
    const { result, getRefreshCalls } = setupHook({ conversations: [conv] });

    archiveImpl = async () => {
      throw new Error("network failure");
    };

    await act(async () => {
      await result.current.handleArchiveConversation(conv);
    });

    expect(getRefreshCalls()).toBe(0);
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

    let unarchivePromise: Promise<void> | undefined;
    act(() => {
      unarchivePromise = result.current.handleUnarchiveConversation(conv);
    });

    // The optimistic clear lands synchronously, before the API resolves —
    // mirroring the archive path.
    expect(readArchived(client, "conv-1")).toBeUndefined();

    d.resolve(undefined);
    await unarchivePromise;

    expect(readArchived(client, "conv-1")).toBeUndefined();
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
      await result.current.handleUnarchiveConversation(conv);
    });

    // The original timestamp is restored — the row re-archives in the UI.
    expect(readArchived(client, "conv-1")).toBe(1234);
  });
});
