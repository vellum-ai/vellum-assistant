/**
 * Covers how a *proven* `deeplink.sendToThread` request is fulfilled once the
 * user lands in the target thread. The load-bearing rule: the send path
 * server-mints a new conversation for an id it does not know, so the request
 * may only turn into a send once the target is confirmed to exist. Otherwise
 * it waits, and when the target is definitively gone (or the park has aged
 * out) it demotes to the pre-fill contract rather than sending anywhere or
 * losing the text; when the user has moved to another thread it becomes the
 * target thread's persisted draft, never the current composer's text.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactNode } from "react";

import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { conversationsByIdGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { ConversationNotFoundError } from "@/utils/fetch-conversation-detail";

const sentryBreadcrumbMock = mock((_args: unknown) => undefined);
mock.module("@sentry/react", () => ({
  addBreadcrumb: sentryBreadcrumbMock,
  captureException: () => {},
}));

import { consumePendingComposerFocus } from "@/domains/chat/composer-focus";
import { useComposerStore } from "@/domains/chat/composer-store";
import {
  PENDING_THREAD_SEND_TTL_MS,
  useDeepLinkThreadSend,
} from "@/domains/chat/hooks/use-deep-link-thread-send";
import {
  __resetPendingDeepLinkForTesting,
  usePendingDeepLinkStore,
} from "@/stores/pending-deep-link-store";

interface Props {
  activeConversationId: string | null;
  conversationExistsOnServer: boolean;
  activeConversationArchived?: boolean;
}

/* The hook reads the target's single-row fetch outcome straight from the
   query cache (the same key `fetchConversationDetail` populates), so each
   test gets a real client and seeds that key: absent (never fetched), or
   settled into the error the real fetch leaves on a 404. */
let queryClient: QueryClient;

function rowKey(conversationId: string) {
  return conversationsByIdGetOptions({
    path: { assistant_id: "assistant-1", id: conversationId },
  }).queryKey;
}

/** Settle the target's row query into the state a 404 leaves behind. */
async function seedRowNotFound(conversationId: string): Promise<void> {
  await queryClient
    .prefetchQuery({
      queryKey: rowKey(conversationId),
      queryFn: () =>
        Promise.reject(new ConversationNotFoundError(conversationId)),
      retry: false,
    })
    .catch(() => {});
}

/** Settle the target's row query into a transient (non-404) failure. */
async function seedRowTransientError(conversationId: string): Promise<void> {
  await queryClient
    .prefetchQuery({
      queryKey: rowKey(conversationId),
      queryFn: () => Promise.reject(new Error("network down")),
      retry: false,
    })
    .catch(() => {});
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
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
        activeConversationArchived: p.activeConversationArchived ?? false,
        sendMessage,
      }),
    { initialProps: initial, wrapper },
  );
  return { ...result, sendMessage };
}

beforeEach(() => {
  __resetPendingDeepLinkForTesting();
  consumePendingComposerFocus();
  sentryBreadcrumbMock.mockClear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const composer = useComposerStore.getState();
  composer.setInput("");
  composer.clearDraft("abc-123");
  composer.clearDraft("other");
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

  it("saves the text as the TARGET thread's draft when the user has moved to a different thread", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingThreadSend("abc-123", "gym done");
    const { sendMessage } = renderSend({
      activeConversationId: "other",
      conversationExistsOnServer: true,
    });

    // Never send into the wrong thread, and never stage the text in the
    // wrong thread's composer either (one tap from the wrong conversation).
    expect(sendMessage).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingThreadSend).toBeNull();
    expect(
      usePendingDeepLinkStore.getState().pendingComposerMessage,
    ).toBeNull();
    // The text lives on as abc-123's persisted draft: restoring for the
    // target key yields it, restoring for the current thread yields nothing.
    const composer = useComposerStore.getState();
    composer.setInput("");
    composer.restoreDraftIfEmpty("other");
    expect(useComposerStore.getState().input).toBe("");
    composer.restoreDraftIfEmpty("abc-123");
    expect(useComposerStore.getState().input).toBe("gym done");
    expect(sentryBreadcrumbMock).toHaveBeenCalledTimes(1);
  });

  it("demotes to a pre-fill when the server reports the target does not exist", async () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingThreadSend("abc-123", "gym done");
    // The active-conversation path fetched the row and the daemon 404ed:
    // the one definitive "not there". A list scan could not say this, since
    // a windowed list is missing every row past its loaded page.
    await seedRowNotFound("abc-123");
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

  it("does not treat a transient row-fetch failure as proof of absence", async () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingThreadSend("abc-123", "gym done");
    // A network failure on the single-row fetch says nothing about the
    // target; only the daemon's 404 does. Keep waiting rather than demote
    // on a guess (the TTL bounds the wait).
    await seedRowTransientError("abc-123");
    const { sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: false,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingThreadSend).not.toBeNull();
    expect(
      usePendingDeepLinkStore.getState().pendingComposerMessage,
    ).toBeNull();
  });

  it("demotes when the target exists but is archived", () => {
    /* The picker offers live conversations, and the daemon does not revive
       an archived thread on send; a target archived after the picker synced
       is found on the server yet must not be sent into. Kept as the
       conservative direction: the text is staged, not dropped. */
    usePendingDeepLinkStore
      .getState()
      .setPendingThreadSend("abc-123", "gym done");
    const { sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: true,
      activeConversationArchived: true,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingThreadSend).toBeNull();
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "gym done",
    );
    expect(consumePendingComposerFocus()).toBe(true);
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
