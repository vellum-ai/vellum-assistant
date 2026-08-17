/**
 * Covers how a *proven* `deeplink.sendToThread` request is fulfilled once the
 * user lands in the target thread. The load-bearing rule: the send path
 * server-mints a new conversation for an id it does not know, so the request
 * may only turn into a send once the target is confirmed to exist. Otherwise
 * it waits, and when the target is definitively gone (or the park has aged
 * out) it demotes to the pre-fill contract rather than sending anywhere or
 * losing the text.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import type { Conversation } from "@/types/conversation-types";

// The hook observes the foreground list to decide "definitively absent".
// Full module surface: `mock.module` is process-global in bun.
let listState: {
  conversations: Conversation[];
  isPending: boolean;
  isError: boolean;
} = { conversations: [], isPending: true, isError: false };
mock.module("@/hooks/conversation-queries", () => ({
  useConversationListQuery: () => ({
    ...listState,
    isLoading: listState.isPending,
    error: null,
    refetch: () => {},
  }),
}));

const sentryBreadcrumbMock = mock((_args: unknown) => undefined);
mock.module("@sentry/react", () => ({
  addBreadcrumb: sentryBreadcrumbMock,
  captureException: () => {},
}));

import { consumePendingComposerFocus } from "@/domains/chat/composer-focus";
import {
  PENDING_THREAD_SEND_TTL_MS,
  useDeepLinkThreadSend,
} from "@/domains/chat/hooks/use-deep-link-thread-send";
import {
  __resetPendingDeepLinkForTesting,
  usePendingDeepLinkStore,
} from "@/stores/pending-deep-link-store";

const conversation = (id: string): Conversation => ({
  conversationId: id,
  title: id,
});

interface Props {
  activeConversationId: string | null;
  conversationExistsOnServer: boolean;
}

function renderSend(initial: Props) {
  const sendMessage = mock(async (_content: string) => {});
  const result = renderHook(
    (p: Props) =>
      useDeepLinkThreadSend({
        assistantId: "assistant-1",
        isAssistantActive: true,
        activeConversationId: p.activeConversationId,
        conversationExistsOnServer: p.conversationExistsOnServer,
        sendMessage,
      }),
    { initialProps: initial },
  );
  return { ...result, sendMessage };
}

beforeEach(() => {
  __resetPendingDeepLinkForTesting();
  consumePendingComposerFocus();
  sentryBreadcrumbMock.mockClear();
  listState = { conversations: [], isPending: true, isError: false };
});
afterEach(() => cleanup());

describe("useDeepLinkThreadSend", () => {
  it("does nothing while nothing is parked", () => {
    const { sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: true,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends once the active thread is the target and confirmed to exist", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingThreadSend("abc-123", "gym done");
    const { sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: true,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("gym done");
    // Consumed exactly once; nothing demoted.
    expect(usePendingDeepLinkStore.getState().pendingThreadSend).toBeNull();
    expect(
      usePendingDeepLinkStore.getState().pendingComposerMessage,
    ).toBeNull();
  });

  it("waits while the target is still resolving, then sends when it is confirmed", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingThreadSend("abc-123", "gym done");
    const { rerender, sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: false,
    });
    // List still loading and the row not confirmed: neither send nor demote.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingThreadSend).not.toBeNull();

    rerender({
      activeConversationId: "abc-123",
      conversationExistsOnServer: true,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("gym done");
  });

  it("waits while the user is on a different thread (navigation not landed)", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingThreadSend("abc-123", "gym done");
    listState = {
      conversations: [conversation("other")],
      isPending: false,
      isError: false,
    };
    const { sendMessage } = renderSend({
      activeConversationId: "other",
      conversationExistsOnServer: true,
    });
    // `other` exists, but it is not the target: never send into the wrong
    // thread, and do not give up on the request either.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingThreadSend?.threadId).toBe(
      "abc-123",
    );
  });

  it("demotes to a pre-fill when the loaded foreground list does not contain the target", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingThreadSend("abc-123", "gym done");
    listState = {
      conversations: [conversation("something-else")],
      isPending: false,
      isError: false,
    };
    const { sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: false,
    });

    // The send path would have minted a NEW conversation for this id, so it
    // must not send. The text is kept, staged for the user, with focus asked.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingThreadSend).toBeNull();
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "gym done",
    );
    expect(consumePendingComposerFocus()).toBe(true);
    expect(sentryBreadcrumbMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat an errored list as proof of absence", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingThreadSend("abc-123", "gym done");
    listState = { conversations: [], isPending: false, isError: true };
    const { sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: false,
    });
    // An errored list served the [] fallback; that says nothing about the
    // target. Keep waiting rather than demote on a guess.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingThreadSend).not.toBeNull();
    expect(
      usePendingDeepLinkStore.getState().pendingComposerMessage,
    ).toBeNull();
  });

  it("demotes an expired park instead of sending, even when the target exists", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingThreadSend("abc-123", "gym done");
    // Age the park past the TTL: a request whose navigation bounced must not
    // fire when the user opens the thread by hand a while later.
    usePendingDeepLinkStore.setState((s) => ({
      pendingThreadSend: s.pendingThreadSend && {
        ...s.pendingThreadSend,
        parkedAt: Date.now() - PENDING_THREAD_SEND_TTL_MS - 1,
      },
    }));
    const { sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: true,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "gym done",
    );
    expect(consumePendingComposerFocus()).toBe(true);
  });

  it("sends exactly once across re-renders", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingThreadSend("abc-123", "gym done");
    const { rerender, sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: true,
    });
    rerender({
      activeConversationId: "abc-123",
      conversationExistsOnServer: true,
    });
    rerender({
      activeConversationId: "abc-123",
      conversationExistsOnServer: true,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
