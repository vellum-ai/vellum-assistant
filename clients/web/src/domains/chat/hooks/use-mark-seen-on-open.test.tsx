/**
 * Opening a conversation with unseen assistant messages marks it seen
 * through the shared mark-seen mutation.
 *
 * The point of these cases is the wiring, not the write: this hook and the
 * explicit "Mark as read" action must produce the same cache effects, so a
 * regression back to a hand-rolled POST (which patched only after the round
 * trip and adjusted no count) shows up here as a missing optimistic update.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import * as sdkGen from "@/generated/daemon/sdk.gen";
import type { Conversation } from "@/types/conversation-types";
import type { ConversationListPage } from "@/utils/conversation-list-fetchers";
import { unreadConversationCountQueryKey } from "@/utils/conversation-list-fetchers";
import { conversationListQueryKey } from "@/utils/conversation-list-keys";
import { listPage } from "@/utils/conversation-list.test-helper";

const seenCalls: Array<{ conversationId: string }> = [];
let seenImpl: () => Promise<unknown> = async () => ({
  data: undefined,
  response: { ok: true },
});

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  conversationsSeenPost: (opts: { body: { conversationId: string } }) => {
    seenCalls.push({ conversationId: opts.body.conversationId });
    return seenImpl();
  },
}));

mock.module("@sentry/react", () => ({
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
}));

const { useMarkSeenOnOpen } =
  await import("@/domains/chat/hooks/use-mark-seen-on-open");

const ASSISTANT_ID = "asst-1";

function unreadConversation(): Conversation {
  return {
    conversationId: "conv-1",
    hasUnseenLatestAssistantMessage: true,
  } as Conversation;
}

function setup(
  conversation: Conversation | undefined,
  unreadCount: number,
  isTranscriptOnScreen = true,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    conversationListQueryKey(ASSISTANT_ID),
    listPage(conversation ? [conversation] : []),
  );
  client.setQueryData(
    unreadConversationCountQueryKey(ASSISTANT_ID),
    unreadCount,
  );

  renderHook(
    () =>
      useMarkSeenOnOpen({
        assistantId: ASSISTANT_ID,
        assistantStateKind: "active",
        activeConversationId: conversation?.conversationId ?? null,
        activeConversation: conversation,
        isTranscriptOnScreen,
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    },
  );

  return { client };
}

function readCount(client: QueryClient): number | null | undefined {
  return client.getQueryData<number | null>(
    unreadConversationCountQueryKey(ASSISTANT_ID),
  );
}

function readUnseen(client: QueryClient): boolean | undefined {
  return client
    .getQueryData<ConversationListPage>(conversationListQueryKey(ASSISTANT_ID))
    ?.conversations.find((c) => c.conversationId === "conv-1")
    ?.hasUnseenLatestAssistantMessage;
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  seenCalls.length = 0;
  seenImpl = async () => ({ data: undefined, response: { ok: true } });
});

afterEach(() => {
  cleanup();
});

describe("useMarkSeenOnOpen", () => {
  test("clears the row and decrements the count before the write resolves", async () => {
    const d = deferred();
    seenImpl = () => d.promise;
    const { client } = setup(unreadConversation(), 3);

    await waitFor(() => {
      expect(seenCalls).toEqual([{ conversationId: "conv-1" }]);
    });

    // Optimistic: both effects land while the POST is still in flight.
    expect(readUnseen(client)).toBe(false);
    expect(readCount(client)).toBe(2);

    await act(async () => {
      d.resolve({ data: undefined, response: { ok: true } });
    });
  });

  test("rolls the row and the count back when the write fails", async () => {
    seenImpl = async () => {
      throw new Error("network failure");
    };
    const { client } = setup(unreadConversation(), 3);

    await waitFor(() => {
      expect(readCount(client)).toBe(3);
    });
    expect(readUnseen(client)).toBe(true);
  });

  test("does not fire for a conversation with nothing unseen", async () => {
    setup(
      {
        conversationId: "conv-1",
        hasUnseenLatestAssistantMessage: false,
      } as Conversation,
      3,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seenCalls).toEqual([]);
  });

  test("fires once per opened conversation", async () => {
    setup(unreadConversation(), 3);

    await waitFor(() => {
      expect(seenCalls.length).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seenCalls.length).toBe(1);
  });
});

describe("useMarkSeenOnOpen only marks what the user can see", () => {
  test("leaves the reply unread while the transcript is off screen", async () => {
    const { client } = setup(unreadConversation(), 1, false);

    await waitFor(() => {
      expect(readUnseen(client)).toBe(true);
    });
    expect(seenCalls).toHaveLength(0);
  });

  test("marks it seen once the transcript is on screen", async () => {
    setup(unreadConversation(), 1, true);

    await waitFor(() => {
      expect(seenCalls).toHaveLength(1);
    });
  });
});
