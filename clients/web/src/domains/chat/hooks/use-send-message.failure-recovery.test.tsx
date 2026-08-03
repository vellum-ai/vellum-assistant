/**
 * Recovery when the send POST throws rather than returning a failure.
 *
 * A throw skips every statement after the `await`, so the draft-mint gate and
 * the user's typed text both depend on being released from a `finally` / the
 * catch block. Losing either one is what a user experiences as the app eating
 * their message: the gate stays held and rejects every later send for the
 * draft, and the composer comes back empty with the optimistic row gone.
 *
 * Driven end-to-end against a spied daemon client, mirroring the sibling
 * plugins test so the module registry stays clean.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useSendMessage } from "@/domains/chat/hooks/use-send-message";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useTurnStore, INITIAL_TURN_STATE } from "@/domains/chat/turn-store";

const DRAFT_ID = "draft-1";
const SENT_TEXT = "resume: oil change, tire change, appraisal";

let postCalls = 0;
const originalPost = daemonClient.post;

const queryClient = new QueryClient();
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function baseProps() {
  return {
    assistantId: "assistant-1",
    activeConversationId: DRAFT_ID,
    diskPressureChatBlockReason: null,
    uiContextRef: { current: null },
    pendingOnboardingContextRef: { current: null },
    onboardingDraftConversationIdRef: { current: null },
    startReconciliationLoop: () => {},
    cancelReconciliation: () => {},
    refreshConversations: async () => {},
  };
}

function renderSend() {
  useAssistantIdentityStore.getState().setIdentity("Assistant", "0.10.12");
  return renderHook(() => useSendMessage(baseProps()), { wrapper: Wrapper });
}

beforeEach(() => {
  postCalls = 0;
  queryClient.clear();
  useConversationStore.getState().reset();
  useTurnStore.setState(INITIAL_TURN_STATE);
  useChatSessionStore.getState().setOptimisticSends([]);
  useChatSessionStore.getState().setError(null);
  useComposerStore.getState().setInput("");
  useResolvedAssistantsStore.getState().setActiveAssistantId(null);

  daemonClient.post = mock(async () => {
    postCalls += 1;
    throw new Error("Load failed");
  }) as typeof daemonClient.post;
});

afterEach(() => {
  daemonClient.post = originalPost;
  cleanup();
});

describe("useSendMessage — recovery when the POST throws", () => {
  test("releases the draft-mint gate so a later send is still accepted", async () => {
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage(SENT_TEXT);
    });
    await act(async () => {
      await result.current.sendMessage("second attempt");
    });

    // A held gate short-circuits before the request, so the second attempt
    // reaching the client is what proves it was released.
    expect(postCalls).toBe(2);
  });

  test("hands the typed text back to the composer and drops the optimistic row", async () => {
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage(SENT_TEXT);
    });

    expect(useComposerStore.getState().input).toBe(SENT_TEXT);
    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(0);
  });
});
