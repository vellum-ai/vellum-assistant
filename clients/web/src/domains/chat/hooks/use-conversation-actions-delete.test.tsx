/**
 * Tests for the optimistic delete path in `useConversationActions`.
 *
 * Delete uses the same TanStack-recommended `useMutation` lifecycle as
 * archive: optimistic `removeConversation` in `onMutate`, restore the
 * caches that held the row in `onError`, and invalidate in `onSettled`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import * as sdkGen from "@/generated/daemon/sdk.gen";
import type { Conversation } from "@/types/conversation-types";
import type { ConversationListPage } from "@/utils/conversation-list-fetchers";
import { conversationListQueryKey } from "@/utils/conversation-list-keys";
import { listPage } from "@/utils/conversation-list.test-helper";

type DeleteImpl = (opts: {
  path: { assistant_id: string; id: string };
  throwOnError: boolean;
}) => Promise<{ data: undefined; response: { ok: boolean } }>;

let deleteImpl: DeleteImpl = async () => ({
  data: undefined,
  response: { ok: true },
});

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  conversationsByIdDelete: (opts: {
    path: { assistant_id: string; id: string };
    throwOnError: boolean;
  }) => deleteImpl(opts),
}));

mock.module("@/utils/haptics", () => ({
  haptic: { medium: () => {}, light: () => {} },
}));

mock.module("@sentry/react", () => ({
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
}));

const { useConversationActions } =
  await import("@/domains/chat/hooks/use-conversation-actions");

const ASSISTANT_ID = "asst-1";

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return { conversationId: "conv-1", ...overrides };
}

function seedClient(conversations: Conversation[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    conversationListQueryKey(ASSISTANT_ID),
    listPage(conversations),
  );
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

function readList(client: QueryClient): Conversation[] {
  return (
    client.getQueryData<ConversationListPage>(
      conversationListQueryKey(ASSISTANT_ID),
    )?.conversations ?? []
  );
}

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
  deleteImpl = async () => ({ data: undefined, response: { ok: true } });
});

afterEach(() => {
  cleanup();
});

describe("handleDeleteConversation — optimistic update", () => {
  test("removes the row from the list cache before the API resolves", async () => {
    const conv = makeConversation({ conversationId: "conv-1" });
    const other = makeConversation({ conversationId: "conv-2" });
    const { result, client } = setupHook({ conversations: [conv, other] });

    const d = deferred();
    deleteImpl = () => d.promise;

    await act(async () => {
      result.current.handleDeleteConversation(conv);
    });

    expect(readList(client).map((c) => c.conversationId)).toEqual(["conv-2"]);

    await act(async () => {
      d.resolve({ data: undefined, response: { ok: true } });
    });
  });

  test("switches to the next foreground conversation before the API resolves", async () => {
    const deleted = makeConversation({ conversationId: "active" });
    const next = makeConversation({ conversationId: "next" });
    const { result, switchCalls } = setupHook({
      conversations: [deleted, next],
      activeConversationId: "active",
    });

    const d = deferred();
    deleteImpl = () => d.promise;

    await act(async () => {
      result.current.handleDeleteConversation(deleted);
    });

    expect(switchCalls).toEqual(["next"]);

    await act(async () => {
      d.resolve({ data: undefined, response: { ok: true } });
    });
  });

  test("starts a new conversation when the deleted row was the last one", async () => {
    const deleted = makeConversation({ conversationId: "active" });
    const { result, startNewCalls } = setupHook({
      conversations: [deleted],
      activeConversationId: "active",
    });

    await act(async () => {
      result.current.handleDeleteConversation(deleted);
    });

    expect(startNewCalls).toHaveLength(1);
  });

  test("does not switch when deleting a non-active conversation", async () => {
    const deleted = makeConversation({ conversationId: "other" });
    const active = makeConversation({ conversationId: "active" });
    const { result, switchCalls, startNewCalls } = setupHook({
      conversations: [active, deleted],
      activeConversationId: "active",
    });

    await act(async () => {
      result.current.handleDeleteConversation(deleted);
    });

    expect(switchCalls).toEqual([]);
    expect(startNewCalls).toHaveLength(0);
  });

  test("rolls the row back into the list when the API rejects", async () => {
    const conv = makeConversation({ conversationId: "conv-1" });
    const { result, client } = setupHook({ conversations: [conv] });

    deleteImpl = async () => {
      throw new Error("network failure");
    };

    await act(async () => {
      result.current.handleDeleteConversation(conv);
    });

    await waitFor(() => {
      expect(readList(client).map((c) => c.conversationId)).toEqual(["conv-1"]);
    });
  });

  test("invalidates conversation caches on success", async () => {
    const conv = makeConversation({ conversationId: "conv-1" });
    const { result, client } = setupHook({ conversations: [conv] });

    const beforeState = client.getQueryState(
      conversationListQueryKey(ASSISTANT_ID),
    );
    expect(beforeState?.isInvalidated).toBe(false);

    await act(async () => {
      result.current.handleDeleteConversation(conv);
    });

    await waitFor(() => {
      const afterState = client.getQueryState(
        conversationListQueryKey(ASSISTANT_ID),
      );
      expect(afterState?.isInvalidated).toBe(true);
    });
  });

  test("invalidates conversation caches even on error", async () => {
    const conv = makeConversation({ conversationId: "conv-1" });
    const { result, client } = setupHook({ conversations: [conv] });

    deleteImpl = async () => {
      throw new Error("network failure");
    };

    await act(async () => {
      result.current.handleDeleteConversation(conv);
    });

    await waitFor(() => {
      const afterState = client.getQueryState(
        conversationListQueryKey(ASSISTANT_ID),
      );
      expect(afterState?.isInvalidated).toBe(true);
    });
  });

  test("does not delete unresolved draft conversations", async () => {
    const draft = makeConversation({
      conversationId: "draft-123",
      draft: true,
    });
    const { result, client } = setupHook({ conversations: [draft] });

    let requestedId: string | undefined;
    deleteImpl = async (opts) => {
      requestedId = opts.path.id;
      return { data: undefined, response: { ok: true } };
    };

    await act(async () => {
      result.current.handleDeleteConversation(draft);
    });

    expect(requestedId).toBeUndefined();
    expect(readList(client).map((c) => c.conversationId)).toEqual(["draft-123"]);
  });

  test("failed delete restores only the deleted row", async () => {
    const deleted = makeConversation({ conversationId: "conv-1" });
    const other = makeConversation({ conversationId: "conv-2" });
    const { result, client } = setupHook({
      conversations: [deleted, other],
    });

    const d = deferred();
    deleteImpl = () => d.promise;

    await act(async () => {
      result.current.handleDeleteConversation(deleted);
    });
    expect(readList(client).map((c) => c.conversationId)).toEqual(["conv-2"]);

    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID),
      listPage([{ ...other, archivedAt: 1234 }]),
    );

    await act(async () => {
      d.reject(new Error("network failure"));
    });

    await waitFor(() => {
      const list = readList(client);
      expect(list.map((c) => c.conversationId)).toEqual(["conv-1", "conv-2"]);
      expect(list.find((c) => c.conversationId === "conv-2")?.archivedAt).toBe(
        1234,
      );
    });
  });

  test("calls DELETE /conversations/:id with the conversation id", async () => {
    const conv = makeConversation({ conversationId: "conv-xyz" });
    const { result } = setupHook({ conversations: [conv] });

    let requestedId: string | undefined;
    deleteImpl = async (opts) => {
      requestedId = opts.path.id;
      return { data: undefined, response: { ok: true } };
    };

    await act(async () => {
      result.current.handleDeleteConversation(conv);
    });

    await waitFor(() => {
      expect(requestedId).toBe("conv-xyz");
    });
  });
});
