/**
 * The draft-mint gate blocks a second send while a draft's first POST is in
 * flight, and is released however that POST settles. A gate still held after
 * the POST rejects refuses every later send for that draft with "Setting up
 * your conversation. Please try again in a moment." for the rest of the
 * session, so the rejection path is the one worth pinning.
 *
 * The mint's other side is pinned here too: when the POST does answer with an
 * id of its own, everything still keyed by the draft id has to follow it.
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
import { useViewerStore } from "@/stores/viewer-store";
import {
  getEditChatConversationId,
  setEditChatConversationId,
} from "@/utils/edit-chat-session";

const DRAFT_ID = "draft-1";
/** The id the assistant answers the mint POST with. */
const MINTED_ID = "conv-minted";
const SURFACE_ID = "surf-1";

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

beforeEach(() => {
  postCalls = 0;
  queryClient.clear();
  useConversationStore.getState().reset();
  useTurnStore.setState(INITIAL_TURN_STATE);
  useChatSessionStore.getState().setOptimisticSends([]);
  useChatSessionStore.getState().setError(null);
  useComposerStore.getState().setInput("");
  useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  useViewerStore.setState({ openedDocumentState: null });
  window.sessionStorage.clear();

  daemonClient.post = mock(async () => {
    postCalls += 1;
    throw new Error("Load failed");
  }) as typeof daemonClient.post;
});

afterEach(() => {
  daemonClient.post = originalPost;
  useViewerStore.setState({ openedDocumentState: null });
  window.sessionStorage.clear();
  cleanup();
});

describe("useSendMessage: draft-mint gate", () => {
  test("releases the gate when the POST throws, so a later send is accepted", async () => {
    useAssistantIdentityStore.getState().setIdentity("Assistant", "0.10.12");
    const { result } = renderHook(() => useSendMessage(baseProps()), {
      wrapper: Wrapper,
    });

    await act(async () => {
      await result.current.sendMessage("first attempt");
    });
    await act(async () => {
      await result.current.sendMessage("second attempt");
    });

    // A held gate short-circuits before the request, so the second attempt
    // reaching the client is what proves it was released.
    expect(postCalls).toBe(2);
  });
});

describe("useSendMessage: a mint that assigns a different id", () => {
  test("carries a document opened against the draft over to the minted id", async () => {
    // GIVEN a document open against the draft this send is about to mint,
    // plus the session cache entry that points the Edit affordance at it
    useAssistantIdentityStore.getState().setIdentity("Assistant", "0.10.12");
    setEditChatConversationId("assistant-1", SURFACE_ID, DRAFT_ID);
    useViewerStore.setState({
      openedDocumentState: {
        source: "document",
        surfaceId: SURFACE_ID,
        conversationId: DRAFT_ID,
        documentName: "README.md",
        content: "# Hello",
      },
    });
    daemonClient.post = mock(async () => {
      postCalls += 1;
      return {
        data: { accepted: true, conversationId: MINTED_ID, messageId: "m1" },
        error: null,
        response: new Response(null, { status: 200 }),
      };
    }) as typeof daemonClient.post;
    const { result } = renderHook(() => useSendMessage(baseProps()), {
      wrapper: Wrapper,
    });

    // WHEN the assistant answers with an id of its own
    await act(async () => {
      await result.current.sendMessage("first message");
    });

    // THEN both caches that held the draft id follow it to the minted one.
    // A viewer store left on the draft id resolves a conversation the server
    // never minted on the next document composer send, which 404s.
    const opened = useViewerStore.getState().openedDocumentState;
    expect(opened?.source).toBe("document");
    expect(opened?.source === "document" ? opened.conversationId : null).toBe(
      MINTED_ID,
    );
    expect(getEditChatConversationId("assistant-1", SURFACE_ID)).toBe(
      MINTED_ID,
    );
  });
});
