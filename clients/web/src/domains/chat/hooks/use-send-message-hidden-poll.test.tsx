/**
 * Regression: a hidden send (the onboarding "Let's chat" kickoff) must NOT run
 * the causal-boundary `pollForResponse` fallback.
 *
 * A hidden user message is intentionally suppressed from `/messages` by the
 * daemon (see `conversation-routes.ts`), so `pollForResponse` — which locates
 * the user message and then the assistant reply after it — can never match. It
 * would spin the full timeout and fire a spurious "Assistant did not respond in
 * time." error even though the proactive greeting streamed in fine over SSE
 * (the exact symptom users hit while testing new assistants in onboarding).
 *
 * The fix skips the poll for hidden sends when there is no matching active
 * stream and leans on the reconciliation loop instead. These tests pin that:
 * hidden → reconciliation loop, no poll, no error; visible → poll as before.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { createElement, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Module mocks — control the send/poll seam and stub side-effect-only deps so
// the test can drive the exact `hasMatchingActiveStream === false` fallback.
// ---------------------------------------------------------------------------
const realMessages = await import("@/domains/chat/api/messages");

let postChatMessageMock = mock(async () => ({
  ok: true as const,
  assistantId: "asst-1",
  conversationId: "conv-A",
  messageId: "user-msg-1",
}));
let pollForResponseMock = mock(async () => null);
let fetchConversationMessagesMock = mock(async () => ({ messages: [], seq: 0 }));

mock.module("@/domains/chat/api/messages", () => ({
  ...realMessages,
  postChatMessage: (...args: unknown[]) => postChatMessageMock(...(args as [])),
  pollForResponse: (...args: unknown[]) => pollForResponseMock(...(args as [])),
  fetchConversationMessages: (...args: unknown[]) =>
    fetchConversationMessagesMock(...(args as [])),
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
const realInteractions = await import("@/domains/chat/api/interactions");
mock.module("@/domains/chat/api/interactions", () => ({
  ...realInteractions,
  getPendingInteractions: async () => ({
    pendingSecret: null,
    pendingConfirmation: null,
  }),
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
  postChatMessageMock = mock(async () => ({
    ok: true as const,
    assistantId: "asst-1",
    conversationId: "conv-A",
    messageId: "user-msg-1",
  }));
  pollForResponseMock = mock(async () => null);
  fetchConversationMessagesMock = mock(async () => ({ messages: [], seq: 0 }));
  // Scope check: the send's assistant/conversation must be the active ones so
  // the fallback branch is reached (not short-circuited as inactive).
  useResolvedAssistantsStore.getState().setActiveAssistantId("asst-1");
  useConversationStore.getState().setActiveConversationId("conv-A");
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [], error: null });
  // Reset turn phase to idle so a prior test's hidden send (which never calls
  // `endTurn`) can't leave the store "sending" and push the next send onto the
  // queue path instead of the active-send/poll path under test.
  useTurnStore.getState().resetTurn();
});

afterEach(() => {
  cleanup();
  useChatSessionStore.setState({ error: null });
});

describe("useSendMessage — hidden send skips the poll fallback", () => {
  test("hidden send starts reconciliation instead of polling, and sets no error", async () => {
    // GIVEN no active stream (streamStore.stream is null by default), so the
    // send takes the poll/reconcile fallback path.
    const startReconciliationLoop = mock(() => {});
    const { result } = renderSend(startReconciliationLoop);

    // WHEN a hidden kickoff message is sent
    await act(async () => {
      await result.current.sendMessage("wake up, my friend", [], {
        hidden: true,
      });
    });

    // THEN the causal-boundary poll (which can never find the suppressed
    // hidden user row) is never invoked...
    expect(pollForResponseMock).not.toHaveBeenCalled();
    // ...the reconciliation loop is started to recover a dropped greeting...
    expect(startReconciliationLoop).toHaveBeenCalledTimes(1);
    // ...and no spurious timeout error is surfaced.
    expect(useChatSessionStore.getState().error).toBeNull();
  });

  test("visible send still uses the poll fallback", async () => {
    // A normal (non-hidden) send whose user row IS present in /messages must
    // keep polling as before — the fix must not disable the fallback broadly.
    const startReconciliationLoop = mock(() => {});
    const { result } = renderSend(startReconciliationLoop);

    await act(async () => {
      await result.current.sendMessage("what can you help me with?");
    });

    expect(pollForResponseMock).toHaveBeenCalledTimes(1);
  });
});
