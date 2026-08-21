/**
 * A send the daemon rejects because the default provider has no usable
 * credential (422 `PROVIDER_NOT_CONFIGURED`, or the legacy generic 422 whose
 * prose names the missing key) must surface through the composer's
 * missing-API-key banner, not a blocking modal or a generic notice, and must
 * hand the typed text straight back to the composer, drafts included.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { createElement, type ReactNode } from "react";

import type { PostMessageResult } from "@/domains/chat/api/messages";

const realMessages = await import("@/domains/chat/api/messages");

let postChatMessageMock = mock(async (): Promise<PostMessageResult> => ({
  ok: false as const,
  status: 422,
  error: {
    code: "PROVIDER_NOT_CONFIGURED",
    detail: 'provider_connection "anthropic-personal" has no API key stored',
  },
}));

mock.module("@/domains/chat/api/messages", () => ({
  ...realMessages,
  postChatMessage: (...args: unknown[]) => postChatMessageMock(...(args as [])),
  deleteQueuedMessage: async () => true,
}));

mock.module("@/lib/backwards-compat/server-minted-conversation", () => ({
  supportsServerMintedConversation: () => false,
}));

mock.module("@/lib/sounds/sound-manager", () => ({
  getSoundManager: () => ({ play: () => {} }),
}));

const realConversationsApi = await import("@/domains/chat/api/conversations");
mock.module("@/domains/chat/api/conversations", () => ({
  ...realConversationsApi,
  surfaceConversation: async () => Date.now(),
}));
const realFetchDetail = await import("@/utils/fetch-conversation-detail");
mock.module("@/utils/fetch-conversation-detail", () => ({
  ...realFetchDetail,
  fetchConversationDetail: async () => {
    throw new realFetchDetail.ConversationNotFoundError("conv-A");
  },
}));

const { useSendMessage } =
  await import("@/domains/chat/hooks/use-send-message");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useChatSessionStore } =
  await import("@/domains/chat/chat-session-store");
const { useComposerStore } = await import("@/domains/chat/composer-store");
const { useTurnStore } = await import("@/domains/chat/turn-store");

const queryClient = new QueryClient();

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(MemoryRouter, null, children),
  );
}

function renderSend() {
  return renderHook(
    () =>
      useSendMessage({
        assistantId: "asst-1",
        activeConversationId: "conv-A",
        diskPressureChatBlockReason: null,
        uiContextRef: { current: null },
        pendingOnboardingContextRef: { current: null },
        onboardingDraftConversationIdRef: { current: null },
        startReconciliationLoop: () => {},
        cancelReconciliation: () => {},
        refreshConversations: async () => {},
      }),
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  useResolvedAssistantsStore.getState().setActiveAssistantId("asst-1");
  useConversationStore.getState().setActiveConversationId("conv-A");
  useChatSessionStore.setState({
    snapshot: null,
    optimisticSends: [],
    error: null,
    pendingQueuedMessageIds: [],
    requestIdToMessageId: new Map(),
    pendingLocalDeletions: new Set(),
  });
  useComposerStore.getState().setInput("");
  useTurnStore.getState().resetTurn();
});

afterEach(() => {
  cleanup();
  useChatSessionStore.setState({ error: null });
});

describe("useSendMessage — provider not configured", () => {
  test("a draft send rejected for a missing key restores the text and sets the banner error", async () => {
    // GIVEN a fresh conversation (no cached row, so the send is a draft) and
    // a daemon with no API key for its default provider
    const { result } = renderSend();

    // WHEN the user sends
    await act(async () => {
      await result.current.sendMessage("hello there");
    });

    // THEN the typed text is back in the composer, the optimistic row is gone,
    // and the error is coded for the missing-API-key banner (inline, no modal)
    expect(useComposerStore.getState().input).toBe("hello there");
    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(0);
    const error = useChatSessionStore.getState().error;
    expect(error?.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(error?.message).toContain("anthropic-personal");
    expect(error?.displayAs).toBeUndefined();
  });

  test("a legacy generic 422 naming the missing key is folded into the same code", async () => {
    postChatMessageMock = mock(async (): Promise<PostMessageResult> => ({
      ok: false as const,
      status: 422,
      error: {
        code: "UNPROCESSABLE_ENTITY",
        detail:
          'provider_connection "anthropic-personal" has no API key stored',
      },
    }));
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage("hello again");
    });

    expect(useComposerStore.getState().input).toBe("hello again");
    expect(useChatSessionStore.getState().error?.code).toBe(
      "PROVIDER_NOT_CONFIGURED",
    );
  });

  test("other 422 rejections of a draft still take the modal path", async () => {
    postChatMessageMock = mock(async (): Promise<PostMessageResult> => ({
      ok: false as const,
      status: 422,
      error: { code: "UNPROCESSABLE_ENTITY", detail: "content is required" },
    }));
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage("hm");
    });

    const error = useChatSessionStore.getState().error;
    expect(error?.displayAs).toBe("modal");
    expect(error?.restoreContent).toBe("hm");
  });
});
