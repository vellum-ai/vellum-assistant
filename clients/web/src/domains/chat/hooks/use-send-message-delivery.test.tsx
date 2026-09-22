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

mock.module("@/domains/chat/api/messages", () => ({
  ...realMessages,
  postChatMessage: (...args: unknown[]) => postChatMessageMock(...(args as [])),
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

const { useSendMessage } =
  await import("@/domains/chat/hooks/use-send-message");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useChatSessionStore } =
  await import("@/domains/chat/chat-session-store");
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
  // Scope check: the send's assistant/conversation must be the active ones so
  // the fallback branch is reached (not short-circuited as inactive).
  useResolvedAssistantsStore.getState().setActiveAssistantId("asst-1");
  useConversationStore.getState().setActiveConversationId("conv-A");
  useChatSessionStore.setState({
    snapshot: null,
    optimisticSends: [],
    error: null,
    requestIdToMessageId: new Map(),
  });
  // Reset turn phase to idle so a prior test's hidden send (which never calls
  // `endTurn`) can't leave the store "sending" and mark the next send as
  // interrupting a turn that is not running.
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

  test("a send during a turn marks itself as interrupting that turn", async () => {
    useTurnStore.setState({ phase: "streaming", activeTurnId: "turn-1" });
    const { result } = renderSend(() => {});

    await act(async () => {
      await result.current.sendMessage("actually, do this instead");
    });

    const turn = useTurnStore.getState();
    expect(turn.activeTurnId).not.toBe("turn-1");
    expect(turn.interruptingTurnId).toBe(turn.activeTurnId);
    expect(postChatMessageMock).toHaveBeenCalledTimes(1);
  });

  test("a send while idle does not mark itself as interrupting", async () => {
    const { result } = renderSend(() => {});

    await act(async () => {
      await result.current.sendMessage("hello");
    });

    expect(useTurnStore.getState().interruptingTurnId).toBeNull();
  });

  test("an older assistant's queued acceptance keeps the row and its request id", async () => {
    postChatMessageMock = mock(async (): Promise<PostMessageResult> => ({
      ok: true as const,
      queued: true,
      assistantId: "asst-1",
      conversationId: "conv-A",
      requestId: "request-1",
    }));
    const startReconciliationLoop = mock(() => {});
    const { result } = renderSend(startReconciliationLoop);

    await act(async () => {
      await result.current.sendMessage("sent to an older assistant");
    });

    const [row] = useChatSessionStore.getState().optimisticSends;
    expect(row?.textSegments).toEqual(["sent to an older assistant"]);
    expect(
      useChatSessionStore.getState().requestIdToMessageId.get("request-1"),
    ).toBe(row?.id);
    expect(useChatSessionStore.getState().error).toBeNull();
    // Nothing was aborted, so no cancel is owed to this send: a Stop during
    // the queued message's turn must read as terminal, not as the handoff.
    expect(useTurnStore.getState().interruptingTurnId).toBeNull();
  });
});
