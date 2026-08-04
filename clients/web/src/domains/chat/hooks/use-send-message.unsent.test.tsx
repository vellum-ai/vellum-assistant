/**
 * A send that does not reach the server leaves its row in the transcript,
 * marked unsent, holding the text and attachments the user submitted. Retry
 * resends that same row under its original `clientMessageId`, which is what
 * lets the daemon deduplicate a message it already received but never answered
 * for; discard drops it.
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

const sentNonces: string[] = [];
const sentBodies: Record<string, unknown>[] = [];
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

const unsentRows = () =>
  useChatSessionStore.getState().optimisticSends.filter((m) => m.sendFailed);

beforeEach(() => {
  sentNonces.length = 0;
  sentBodies.length = 0;
  queryClient.clear();
  useConversationStore.getState().reset();
  useTurnStore.setState(INITIAL_TURN_STATE);
  useChatSessionStore.getState().setOptimisticSends([]);
  useChatSessionStore.getState().setError(null);
  useComposerStore.getState().setInput("");
  useResolvedAssistantsStore.getState().setActiveAssistantId("assistant-1");
  useConversationStore.getState().setActiveConversationId(DRAFT_ID);

  daemonClient.post = mock(
    async (options: { body?: Record<string, unknown> }) => {
      sentBodies.push(options.body ?? {});
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

describe("useSendMessage: a send that never reaches the server", () => {
  test("keeps the message on screen, marked unsent, with its text", async () => {
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage(SENT_TEXT);
    });

    const rows = unsentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textSegments).toEqual([SENT_TEXT]);
    // The composer is left alone; the message lives in the transcript.
    expect(useComposerStore.getState().input).toBe("");
  });

  test("retry resends the same row under its original identity", async () => {
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage(SENT_TEXT);
    });
    const rowId = unsentRows()[0]!.id;

    await act(async () => {
      await result.current.retryFailedSend(rowId);
    });

    expect(sentNonces).toHaveLength(2);
    expect(sentNonces[0]).toBe(sentNonces[1]!);
    // Still one row, not a second copy stacked beside the first.
    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(1);
  });

  test("discard drops the row", async () => {
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage(SENT_TEXT);
    });
    const rowId = unsentRows()[0]!.id;

    act(() => {
      result.current.discardFailedSend(rowId);
    });

    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(0);
  });

  test("a send that fails while another turn is active is also kept", async () => {
    // The queue branch used to revert the row outright, so an ordinary message
    // sent while the assistant was busy still vanished on failure.
    useTurnStore.setState({ ...INITIAL_TURN_STATE, phase: "sending" });
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage(SENT_TEXT);
    });

    const rows = unsentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textSegments).toEqual([SENT_TEXT]);
    // Queue bookkeeping is dropped: the message never reached the server queue.
    expect(rows[0]!.queueStatus).toBeUndefined();
    expect(
      useChatSessionStore.getState().pendingQueuedMessageIds,
    ).not.toContain(rows[0]!.id);
  });

  test("retry carries the original send's scripted provenance", async () => {
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage(SENT_TEXT, [], { scripted: true });
    });
    const row = unsentRows()[0]!;
    expect(row.sendFailed?.scripted).toBe(true);

    await act(async () => {
      await result.current.retryFailedSend(row.id);
    });

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[1]!.scripted).toBe(true);
  });

  test("a hidden machine send leaves nothing behind to retry", async () => {
    const { result } = renderSend();

    await act(async () => {
      await result.current.sendMessage("<system marker>", [], { hidden: true });
    });

    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(0);
  });
});
