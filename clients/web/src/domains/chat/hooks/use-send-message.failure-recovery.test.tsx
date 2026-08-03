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
const sentNonces: string[] = [];
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
  sentNonces.length = 0;
  queryClient.clear();
  useConversationStore.getState().reset();
  useTurnStore.setState(INITIAL_TURN_STATE);
  useChatSessionStore.getState().setOptimisticSends([]);
  useChatSessionStore.getState().setError(null);
  useComposerStore.getState().setInput("");
  // The restore path only runs for a send the user is still looking at, so
  // the scope has to read as current here.
  useResolvedAssistantsStore.getState().setActiveAssistantId("assistant-1");
  useConversationStore.getState().setActiveConversationId(DRAFT_ID);

  daemonClient.post = mock(
    async (options: { body?: Record<string, unknown> }) => {
      postCalls += 1;
      const nonce = options.body?.clientMessageId;
      if (typeof nonce === "string") {
        sentNonces.push(nonce);
      }
      throw new Error("Load failed");
    },
  ) as typeof daemonClient.post;
});

afterEach(() => {
  daemonClient.post = originalPost;
  cleanup();
});

describe("useSendMessage: recovery when the POST throws", () => {
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

  test("retries the restored text under the original nonce", async () => {
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage(SENT_TEXT);
    });
    await act(async () => {
      await result.current.sendMessage(SENT_TEXT);
    });

    // A throw leaves delivery unknown, so the retry has to carry the first
    // send's nonce or the daemon cannot dedup a message that did land.
    expect(sentNonces).toHaveLength(2);
    expect(sentNonces[0]).toBe(sentNonces[1]!);
  });

  test("starts a new nonce when the user edits the text before resending", async () => {
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage(SENT_TEXT);
    });
    await act(async () => {
      await result.current.sendMessage(SENT_TEXT + " and grease the PTO");
    });

    expect(sentNonces[0]).not.toBe(sentNonces[1]!);
  });

  test("does not put a hidden machine send into the composer", async () => {
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage("<system marker>", [], {
        hidden: true,
      });
    });

    expect(useComposerStore.getState().input).toBe("");
  });
});
