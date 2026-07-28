/**
 * Reply delivery is owned by the SSE stream + the reconciliation loop — the
 * send path has no client-side `/messages` polling fallback.
 *
 * When a send dispatches with no matching active stream (a brand-new
 * conversation whose stream context hasn't switched yet, or a hidden onboarding
 * kickoff whose user row the daemon suppresses), the hook kicks the
 * reconciliation loop and returns. It must NOT spin a 120s timer that used to
 * fire a spurious "Assistant did not respond in time." even when the turn
 * failed with a real (server-reported) error or was simply still running.
 *
 * These tests pin that both hidden and visible sends take the same
 * reconciliation-backed path and surface no timeout error.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { createElement, type ReactNode } from "react";

import type { PostMessageResult } from "@/domains/chat/api/messages";

// ---------------------------------------------------------------------------
// Module mocks — control the send seam and stub side-effect-only deps so the
// test can drive the exact `hasMatchingActiveStream === false` fallback.
// ---------------------------------------------------------------------------
const realMessages = await import("@/domains/chat/api/messages");

let postChatMessageMock = mock(async (): Promise<PostMessageResult> => ({
  ok: true as const,
  assistantId: "asst-1",
  conversationId: "conv-A",
  messageId: "user-msg-1",
}));
let deleteQueuedMessageMock = mock(async () => true);

mock.module("@/domains/chat/api/messages", () => ({
  ...realMessages,
  postChatMessage: (...args: unknown[]) => postChatMessageMock(...(args as [])),
  deleteQueuedMessage: (...args: unknown[]) =>
    deleteQueuedMessageMock(...(args as [])),
}));

// Server-mint gating reads a backwards-compat store; force the legacy path so
// the hidden draft doesn't take the server-mint branch (irrelevant here).
mock.module("@/lib/backwards-compat/server-minted-conversation", () => ({
  supportsServerMintedConversation: () => false,
}));

// The sound manager touches Web Audio on send; stub it out.
mock.module("@/lib/sounds/sound-manager", () => ({
  getSoundManager: () => ({ play: () => {} }),
}));

// Best-effort, detached network calls fired along the send path — stub them so
// the test never hits the network (an unhandled ECONNREFUSED would otherwise
// surface between tests and can fail strict CI runners).
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

const { useSendMessage } = await import(
  "@/domains/chat/hooks/use-send-message"
);
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);
const { useConversationStore } = await import("@/stores/conversation-store");
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);
const { useTurnStore } = await import("@/domains/chat/turn-store");

const queryClient = new QueryClient();

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(MemoryRouter, null, children),
  );
}

function renderSend(startReconciliationLoop: () => void) {
  return renderHook(
    () =>
      useSendMessage({
        assistantId: "asst-1",
        activeConversationId: "conv-A",
        diskPressureChatBlockReason: null,
        uiContextRef: { current: null },
        pendingOnboardingContextRef: { current: null },
        onboardingDraftConversationIdRef: { current: null },
        startReconciliationLoop,
        cancelReconciliation: () => {},
        refreshConversations: async () => {},
      }),
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  postChatMessageMock = mock(async (): Promise<PostMessageResult> => ({
    ok: true as const,
    assistantId: "asst-1",
    conversationId: "conv-A",
    messageId: "user-msg-1",
  }));
  deleteQueuedMessageMock = mock(async () => true);
  // Scope check: the send's assistant/conversation must be the active ones so
  // the fallback branch is reached (not short-circuited as inactive).
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
  // Reset turn phase to idle so a prior test's hidden send (which never calls
  // `endTurn`) can't leave the store "sending" and push the next send onto the
  // queue path instead of the active-send path under test.
  useTurnStore.getState().resetTurn();
});

afterEach(() => {
  cleanup();
  useChatSessionStore.setState({ error: null });
});

describe("useSendMessage — SSE + reconciliation own delivery (no poll)", () => {
  test("hidden send starts reconciliation and sets no error", async () => {
    // GIVEN no active stream (streamStore.stream is null by default), so the
    // send takes the reconciliation-backed fallback path.
    const startReconciliationLoop = mock(() => {});
    const { result } = renderSend(startReconciliationLoop);

    await act(async () => {
      await result.current.sendMessage("wake up, my friend", [], {
        hidden: true,
      });
    });

    // The reconciliation loop is the disconnect-safe backstop; delivery and any
    // failure surface over SSE.
    expect(startReconciliationLoop).toHaveBeenCalledTimes(1);
    // No client-side timeout error is manufactured.
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  test("visible send takes the same reconciliation-backed path, no timeout error", async () => {
    const startReconciliationLoop = mock(() => {});
    const { result } = renderSend(startReconciliationLoop);

    await act(async () => {
      await result.current.sendMessage("what can you help me with?");
    });

    expect(startReconciliationLoop).toHaveBeenCalledTimes(1);
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  test("an early queue cancellation deletes after the POST supplies its request id", async () => {
    let resolvePost: (result: PostMessageResult) => void = () => {};
    postChatMessageMock = mock(
      () =>
        new Promise<PostMessageResult>((resolve) => {
          resolvePost = resolve;
        }),
    );
    useTurnStore.setState({
      phase: "streaming",
      activeTurnId: "turn-1",
    });
    const { result } = renderSend(() => {});
    let sendPromise: Promise<void> = Promise.resolve();

    await act(async () => {
      sendPromise = result.current.sendMessage("cancel this queued message");
      await Promise.resolve();
    });
    const messageId = useChatSessionStore.getState().optimisticSends[0]?.id;
    if (!messageId) {
      throw new Error("Expected an optimistic queued message");
    }

    act(() => {
      result.current.handleCancelQueuedMessage(messageId);
    });

    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(1);
    expect(
      useChatSessionStore.getState().pendingLocalDeletions.has(messageId),
    ).toBe(true);

    await act(async () => {
      resolvePost({
        ok: true,
        queued: true,
        assistantId: "asst-1",
        conversationId: "conv-A",
        requestId: "request-1",
      });
      await sendPromise;
    });

    expect(deleteQueuedMessageMock).toHaveBeenCalledWith(
      "asst-1",
      "conv-A",
      "request-1",
    );
    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(0);
    expect(useChatSessionStore.getState().requestIdToMessageId.size).toBe(0);
  });
});
