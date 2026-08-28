/**
 * A send entered after the user moved to another thread.
 *
 * `submitMessage` awaits before it calls in here: the composer resolves the
 * Eyes camera frame, and an edited message reposts through an undo first. Both
 * hold a call that closed over the conversation the click happened in, and a
 * conversation switch during either lands the send in this hook with the
 * session store already belonging to somewhere else.
 *
 * The message still goes to the conversation it was written in, because the
 * POST targets the id this call carries. What must not happen is the send
 * writing into the stores that describe the ONE thread on screen: the
 * optimistic row and the queue FIFO, which nothing would take back out (a
 * switch clears them, and these arrive after that); the turn phase, whose
 * matching `acceptSend` is scope-checked and would leave the composer disabled;
 * and the interactive surfaces, which belong to the thread the user is reading.
 *
 * Driven against a spied daemon client rather than `mock.module`, so the module
 * registry stays clean for the sibling send suites.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useSendMessage } from "@/domains/chat/hooks/use-send-message";
import {
  INITIAL_TURN_STATE,
  isSending,
  useTurnStore,
} from "@/domains/chat/turn-store";
import type { EphemeralMetaResult } from "@/domains/chat/types/types";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** The thread the send was written in. */
const SEND_CONVERSATION = "conv-written-in";
/** The thread the user moved to while the send was awaiting. */
const OPEN_CONVERSATION = "conv-now-open";

let capturedBody: Record<string, unknown> | null = null;
const originalPost = daemonClient.post;

/**
 * The conversation the POST targeted. The id rides in the body under one of two
 * wire fields depending on the assistant's version, and which one it picked is
 * not what these tests are about.
 */
function postedConversationId(): unknown {
  return capturedBody?.conversationId ?? capturedBody?.conversationKey;
}

const queryClient = new QueryClient();
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

/**
 * The hook as the composer holds it: bound to the conversation the click
 * happened in. A switch during the await moves the stores, not this.
 */
function renderSendFor(conversationId: string) {
  const props = {
    assistantId: "assistant-1",
    activeConversationId: conversationId,
    diskPressureChatBlockReason: null,
    uiContextRef: { current: null },
    pendingOnboardingContextRef: { current: null },
    onboardingDraftConversationIdRef: { current: null },
    startReconciliationLoop: () => {},
    cancelReconciliation: () => {},
    refreshConversations: async () => {},
  };
  return renderHook(() => useSendMessage(props), { wrapper: Wrapper });
}

beforeEach(() => {
  capturedBody = null;
  queryClient.clear();
  useConversationStore.getState().reset();
  useTurnStore.setState(INITIAL_TURN_STATE);
  useChatSessionStore.setState({
    optimisticSends: [],
    error: null,
    pendingQueuedMessageIds: [],
  });
  useResolvedAssistantsStore.getState().setActiveAssistantId("assistant-1");

  daemonClient.post = mock(
    async (options: { body?: Record<string, unknown> }) => {
      capturedBody = options.body ?? null;
      return {
        data: {
          accepted: true,
          conversationId: SEND_CONVERSATION,
          messageId: "m1",
        },
        error: null,
        response: new Response(null, { status: 200 }),
      };
    },
  ) as typeof daemonClient.post;
});

afterEach(() => {
  daemonClient.post = originalPost;
  cleanup();
});

describe("useSendMessage: a send whose thread is no longer open", () => {
  test("paints no optimistic row in the transcript that is open now", async () => {
    // GIVEN the user switched threads while the send was awaiting
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("what am I holding?");
    });

    // THEN the row it would have painted is absent from the session store the
    // open thread renders from.
    expect(useChatSessionStore.getState().optimisticSends).toEqual([]);
    // AND the message still went to the thread it was written in.
    expect(postedConversationId()).toBe(SEND_CONVERSATION);
  });

  test("the queue path leaves the open transcript alone too", async () => {
    // The queue path posts and returns without ever reaching the send's
    // post-POST scope check, so its row would otherwise stay put for good.
    useTurnStore.setState({ phase: "streaming", activeTurnId: "turn-1" });
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("queue this one");
    });

    expect(useChatSessionStore.getState().optimisticSends).toEqual([]);
    // The pending FIFO is held in the same store, and an ack for a thread it
    // does not describe would bind to the next visible send's row.
    expect(useChatSessionStore.getState().pendingQueuedMessageIds).toEqual([]);
    expect(postedConversationId()).toBe(SEND_CONVERSATION);
  });

  test("leaves the open thread's turn phase alone", async () => {
    // `requestSend` puts the turn store into a submitting phase, and the
    // matching `acceptSend` is scope-checked, so a stale send that reached it
    // would leave the open thread submitting forever with its composer
    // disabled and no turn behind it.
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("what am I holding?");
    });

    expect(isSending(useTurnStore.getState().phase)).toBe(false);
    expect(useTurnStore.getState().phase).toBe(INITIAL_TURN_STATE.phase);
  });

  test("leaves the open thread's interactive surfaces standing", async () => {
    // A send supersedes the surfaces of the thread it is sent into. A stale
    // one has nothing on screen to supersede, so a pending confirmation the
    // user has not answered in the thread they just opened must survive it.
    useConversationStore.getState().setActiveConversationId(OPEN_CONVERSATION);
    const standingCard: EphemeralMetaResult = {
      id: "meta-1",
      kind: "info",
      text: "all good",
    };
    useChatSessionStore.setState({ ephemeralMetaResults: [standingCard] });
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("what am I holding?");
    });

    expect(useChatSessionStore.getState().ephemeralMetaResults).toHaveLength(1);
  });

  test("the row is painted as usual while the thread is still open", async () => {
    useConversationStore.getState().setActiveConversationId(SEND_CONVERSATION);
    const { result } = renderSendFor(SEND_CONVERSATION);

    await act(async () => {
      await result.current.sendMessage("still here");
    });

    const rows = useChatSessionStore.getState().optimisticSends;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textSegments).toEqual(["still here"]);
  });
});
