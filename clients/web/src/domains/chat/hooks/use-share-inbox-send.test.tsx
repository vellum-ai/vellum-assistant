/**
 * Covers how a parked share-inbox send is fulfilled once the user lands
 * in the target conversation. Existing threads must be confirmed before
 * send; a new draft minted for this share may send without that check.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import type { Conversation } from "@/types/conversation-types";

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
import { useComposerStore } from "@/domains/chat/composer-store";
import {
  PENDING_SHARE_SEND_TTL_MS,
  useShareInboxSend,
} from "@/domains/chat/hooks/use-share-inbox-send";
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
  const sendMessage = mock(async (_content: string, _atts?: unknown) => {});
  const result = renderHook(
    (p: Props) =>
      useShareInboxSend({
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

function park(partial: {
  threadId: string;
  isNewDraft?: boolean;
  text?: string;
  files?: File[];
}) {
  usePendingDeepLinkStore.getState().setPendingShareSend({
    threadId: partial.threadId,
    isNewDraft: partial.isNewDraft ?? false,
    text: partial.text ?? "shared text",
    files: partial.files ?? [],
  });
}

beforeEach(() => {
  __resetPendingDeepLinkForTesting();
  consumePendingComposerFocus();
  sentryBreadcrumbMock.mockClear();
  listState = { conversations: [], isPending: true, isError: false };
  const composer = useComposerStore.getState();
  composer.setInput("");
  composer.resetAttachments();
  composer.clearDraft("abc-123");
  composer.clearDraft("other");
});
afterEach(() => cleanup());

describe("useShareInboxSend", () => {
  it("sends on a new draft without waiting for a server row", () => {
    park({ threadId: "draft-1", isNewDraft: true, text: "from photos" });
    const { sendMessage } = renderSend({
      activeConversationId: "draft-1",
      conversationExistsOnServer: false,
    });
    expect(sendMessage).toHaveBeenCalledWith("from photos", []);
    expect(usePendingDeepLinkStore.getState().pendingShareSend).toBeNull();
  });

  it("sends an existing thread only once it is confirmed", () => {
    park({ threadId: "abc-123", text: "from safari" });
    const { rerender, sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: false,
    });
    expect(sendMessage).not.toHaveBeenCalled();

    rerender({
      activeConversationId: "abc-123",
      conversationExistsOnServer: true,
    });
    expect(sendMessage).toHaveBeenCalledWith("from safari", []);
  });

  it("saves the text as the target draft when the user navigates away", () => {
    park({ threadId: "abc-123", text: "keep me" });
    const { sendMessage } = renderSend({
      activeConversationId: "other",
      conversationExistsOnServer: true,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    const composer = useComposerStore.getState();
    composer.setInput("");
    composer.restoreDraftIfEmpty("abc-123");
    expect(useComposerStore.getState().input).toBe("keep me");
  });

  it("demotes a stale thread id to a pre-fill", () => {
    park({ threadId: "abc-123", text: "stale pick" });
    listState = {
      conversations: [conversation("something-else")],
      isPending: false,
      isError: false,
    };
    const { sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: false,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "stale pick",
    );
    expect(consumePendingComposerFocus()).toBe(true);
  });

  it("sends only this share and leaves a pre-existing strip attachment", () => {
    useComposerStore.setState({
      attachments: [
        {
          kind: "uploaded",
          localId: "already-there",
          id: "att-existing",
          filename: "old.png",
          mimeType: "image/png",
          sizeBytes: 12,
          previewUrl: null,
          thumbnailUrl: null,
        },
      ],
    });
    park({ threadId: "abc-123", isNewDraft: true, text: "just text" });
    const { sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: false,
    });
    expect(sendMessage).toHaveBeenCalledWith("just text", []);
    const remaining = useComposerStore.getState().attachments;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.localId).toBe("already-there");
  });

  it("demotes an expired park instead of sending", () => {
    park({ threadId: "abc-123", isNewDraft: true, text: "late" });
    usePendingDeepLinkStore.setState((s) => ({
      pendingShareSend: s.pendingShareSend && {
        ...s.pendingShareSend,
        parkedAt: Date.now() - PENDING_SHARE_SEND_TTL_MS - 1,
      },
    }));
    const { sendMessage } = renderSend({
      activeConversationId: "abc-123",
      conversationExistsOnServer: false,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingComposerMessage).toBe(
      "late",
    );
  });
});
