/**
 * Tests for `QueuedSendRecoveryWatcher`, the always-mounted watcher that hands
 * a queued send's message back when the daemon refuses to persist it.
 *
 * The queued sends are put straight into `composer-store` rather than by
 * running a real send, so these tests pin the watcher's own filtering (which
 * stream events answer for a held send, and which conversations it answers
 * for) independently of `useSendMessage`, whose hand-off to the store is
 * covered by its own test files. The event bus, `useComposerStore`, and
 * `useConversationStore` are real; only the toast surface is mocked.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const toastErrorMock = mock((..._args: unknown[]) => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    info: (..._args: unknown[]) => {},
    success: (..._args: unknown[]) => {},
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

let isOrgReady = false;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => isOrgReady,
}));

const realMessages = await import("@/domains/chat/api/messages");
interface ConversationSnapshot {
  messages: Array<{
    id: string;
    clientMessageId?: string;
    role: "user" | "assistant";
    timestamp: string;
    attachments: never[];
    queueStatus?: "queued" | "processing";
  }>;
  processing?: boolean;
}
let fetchConversationMessagesMock = mock(
  async (..._args: unknown[]): Promise<ConversationSnapshot> => ({
    messages: [],
    processing: true,
  }),
);
mock.module("@/domains/chat/api/messages", () => ({
  ...realMessages,
  fetchConversationMessages: (...args: unknown[]) =>
    fetchConversationMessagesMock(...args),
}));

const { failedSendFor, useComposerStore } =
  await import("@/domains/chat/composer-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { publish } = await import("@/lib/event-bus");
const { QueuedSendRecoveryWatcher } =
  await import("@/domains/chat/components/queued-send-recovery-watcher");

import type { DisplayAttachment } from "@/types/attachment-types";

const attachment: DisplayAttachment = {
  id: "srv-queued",
  filename: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  previewUrl: null,
};

function recordQueuedSend(clientMessageId: string, conversationId: string) {
  useComposerStore.getState().recordQueuedSend(clientMessageId, {
    assistantId: "assistant-1",
    conversationId,
    content: "parked behind the running turn",
    attachments: [attachment],
  });
}

function publishUserMessageEcho(
  conversationId: string,
  clientMessageId?: string,
) {
  act(() => {
    publish("sse.event", {
      id: `evt-echo-${conversationId}`,
      emittedAt: new Date().toISOString(),
      message: {
        type: "user_message_echo",
        text: "parked behind the running turn",
        conversationId,
        ...(clientMessageId ? { clientMessageId } : {}),
      },
    });
  });
}

function publishStreamError(
  conversationId: string,
  clientMessageId?: string,
  scope: "message" | "turn" = "message",
) {
  act(() => {
    publish("sse.event", {
      id: `evt-error-${conversationId}`,
      emittedAt: new Date().toISOString(),
      message:
        scope === "message"
          ? {
              type: "message_failed",
              message: "Failed to persist message.",
              conversationId,
              requestId: `req-${conversationId}`,
              ...(clientMessageId ? { clientMessageId } : {}),
            }
          : {
              type: "error",
              message: "Failed to persist message.",
              conversationId,
              scope,
              ...(clientMessageId ? { clientMessageId } : {}),
            },
    });
  });
}

function publishMessageQueuedDeleted(
  conversationId: string,
  clientMessageId?: string,
) {
  act(() => {
    publish("sse.event", {
      id: `evt-queued-deleted-${conversationId}`,
      emittedAt: new Date().toISOString(),
      message: {
        type: "message_queued_deleted",
        conversationId,
        requestId: `req-${conversationId}`,
        ...(clientMessageId ? { clientMessageId } : {}),
      },
    });
  });
}

function heldFor(conversationId: string, assistantId = "assistant-1") {
  return failedSendFor(
    useComposerStore.getState(),
    assistantId,
    conversationId,
  );
}

function stillQueued(clientMessageId: string): boolean {
  return useComposerStore.getState().queuedSends.has(clientMessageId);
}

beforeEach(() => {
  useComposerStore.setState({
    queuedSends: new Map(),
    failedSendsByConversation: new Map(),
    claimedQueuedSendIds: new Set(),
  });
  useConversationStore.getState().reset();
  useConversationStore.getState().setActiveConversationId("conv-open");
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  isOrgReady = false;
  fetchConversationMessagesMock = mock(
    async (..._args: unknown[]): Promise<ConversationSnapshot> => ({
      messages: [],
      processing: true,
    }),
  );
  toastErrorMock.mockClear();
});

afterEach(() => {
  cleanup();
  useComposerStore.setState({
    queuedSends: new Map(),
    failedSendsByConversation: new Map(),
    claimedQueuedSendIds: new Set(),
  });
});

describe("QueuedSendRecoveryWatcher", () => {
  test("switching back exposes a correlated recovery for a missed failure", async () => {
    isOrgReady = true;
    fetchConversationMessagesMock = mock(
      async (..._args: unknown[]): Promise<ConversationSnapshot> => ({
        messages: [],
        processing: false,
      }),
    );
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
    recordQueuedSend("nonce-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
    });

    await waitFor(() => expect(heldFor("conv-left")).toBeDefined());
    expect(stillQueued("nonce-1")).toBe(true);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);

    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
      useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
    });
    await waitFor(() =>
      expect(fetchConversationMessagesMock).toHaveBeenCalledTimes(2),
    );
    expect(toastErrorMock).toHaveBeenCalledTimes(1);

    publishUserMessageEcho("conv-left", "nonce-1");

    expect(heldFor("conv-left")).toBeUndefined();
    expect(stillQueued("nonce-1")).toBe(false);
  });

  test("switching back drops recovery when history contains the send", async () => {
    isOrgReady = true;
    fetchConversationMessagesMock = mock(
      async (..._args: unknown[]): Promise<ConversationSnapshot> => ({
        messages: [
          {
            id: "msg-1",
            clientMessageId: "nonce-1",
            role: "user",
            timestamp: new Date().toISOString(),
            attachments: [],
          },
        ],
        processing: false,
      }),
    );
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
    recordQueuedSend("nonce-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
    });

    await waitFor(() => expect(stillQueued("nonce-1")).toBe(false));
    expect(heldFor("conv-left")).toBeUndefined();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test("the daemon's echo lets the client copy go", () => {
    recordQueuedSend("nonce-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    publishUserMessageEcho("conv-left", "nonce-1");

    expect(stillQueued("nonce-1")).toBe(false);
    // The message is persisted, so nothing is owed to that conversation.
    expect(heldFor("conv-left")).toBeUndefined();
  });

  test("a late echo retracts a full payload held after an ambiguous failure", () => {
    recordQueuedSend("nonce-1", "conv-left");
    useComposerStore.getState().stashFailedSend("assistant-1", "conv-left", {
      content: "parked behind the running turn",
      attachments: [attachment],
    });
    render(<QueuedSendRecoveryWatcher />);

    publishUserMessageEcho("conv-left", "nonce-1");

    expect(heldFor("conv-left")).toBeUndefined();
    expect(stillQueued("nonce-1")).toBe(false);
  });

  test("a late echo leaves matching text that was not restored by this send", () => {
    useConversationStore.getState().setActiveConversationId("conv-left");
    recordQueuedSend("nonce-1", "conv-left");
    useComposerStore.getState().setInput("parked behind the running turn");
    useComposerStore.getState().restoreAttachmentsIfEmpty([attachment]);
    render(<QueuedSendRecoveryWatcher />);

    publishUserMessageEcho("conv-left", "nonce-1");

    expect(useComposerStore.getState().input).toBe(
      "parked behind the running turn",
    );
    expect(useComposerStore.getState().attachments).toHaveLength(1);
    expect(stillQueued("nonce-1")).toBe(false);
  });

  test("a late echo clears the recovery this send restored on screen", () => {
    useConversationStore.getState().setActiveConversationId("conv-left");
    recordQueuedSend("nonce-1", "conv-left");
    useComposerStore.getState().stashFailedSend(
      "assistant-1",
      "conv-left",
      {
        content: "parked behind the running turn",
        attachments: [attachment],
      },
      "nonce-1",
    );
    useComposerStore.getState().takeFailedSend("assistant-1", "conv-left");
    useComposerStore.getState().setInput("parked behind the running turn");
    useComposerStore.getState().restoreAttachmentsIfEmpty([attachment]);
    render(<QueuedSendRecoveryWatcher />);

    publishUserMessageEcho("conv-left", "nonce-1");

    expect(useComposerStore.getState().input).toBe("");
    expect(useComposerStore.getState().attachments).toEqual([]);
    expect(stillQueued("nonce-1")).toBe(false);
  });

  test("leaving every assistant clears all held chat sends", () => {
    recordQueuedSend("nonce-1", "conv-left");
    useComposerStore.getState().stashFailedSend(
      "assistant-1",
      "conv-left",
      {
        content: "parked behind the running turn",
        attachments: [attachment],
      },
      "nonce-1",
    );
    useComposerStore.getState().takeFailedSend("assistant-1", "conv-left");
    useComposerStore.getState().stashFailedSend(
      "assistant-1",
      "conv-other",
      { content: "another failed send", attachments: [] },
    );
    render(<QueuedSendRecoveryWatcher />);

    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: null });
    });

    const composer = useComposerStore.getState();
    expect(composer.queuedSends).toEqual(new Map());
    expect(composer.failedSendsByConversation).toEqual(new Map());
    expect(composer.claimedQueuedSendIds).toEqual(new Set());
  });

  test("an assistant switch keeps recovery scoped to its originating assistant", () => {
    useComposerStore.getState().stashFailedSend("assistant-1", "conv-shared", {
      content: "parked behind the running turn",
      attachments: [attachment],
    });

    useComposerStore.getState().fullReset();

    expect(heldFor("conv-shared", "assistant-2")).toBeUndefined();
    expect(heldFor("conv-shared", "assistant-1")).toEqual({
      content: "parked behind the running turn",
      attachments: [attachment],
    });
  });

  test("the daemon's echo takes back the draft written for a request that looked lost", () => {
    useComposerStore.getState().loadAssistantDrafts("assistant-1", null);
    recordQueuedSend("nonce-1", "conv-left");
    useComposerStore
      .getState()
      .restoreFailedDraft(
        "assistant-1",
        "conv-left",
        "parked behind the running turn",
      );
    render(<QueuedSendRecoveryWatcher />);

    publishUserMessageEcho("conv-left", "nonce-1");

    // The message was taken, so the draft would only offer it a second time:
    // opening the conversation finds no draft.
    useComposerStore.getState().handleConversationSwitch({
      previousKey: "conv-other",
      nextKey: "conv-left",
    });
    expect(useComposerStore.getState().input).toBe("");
    expect(stillQueued("nonce-1")).toBe(false);
  });

  test("the daemon's echo leaves a draft the user has edited since", () => {
    useComposerStore.getState().loadAssistantDrafts("assistant-1", null);
    recordQueuedSend("nonce-1", "conv-left");
    useComposerStore
      .getState()
      .restoreFailedDraft("assistant-1", "conv-left", "edited since");
    render(<QueuedSendRecoveryWatcher />);

    publishUserMessageEcho("conv-left", "nonce-1");

    useComposerStore.getState().handleConversationSwitch({
      previousKey: "conv-other",
      nextKey: "conv-left",
    });
    expect(useComposerStore.getState().input).toBe("edited since");
  });

  test("a failure in a conversation the user has left hands the message back", () => {
    recordQueuedSend("nonce-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    publishStreamError("conv-left", "nonce-1");

    expect(heldFor("conv-left")).toEqual({
      content: "parked behind the running turn",
      attachments: [attachment],
    });
    expect(stillQueued("nonce-1")).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe(
      "A message couldn't be sent. It's back in that conversation's composer.",
    );
  });

  test("a failure does not hold a recovery that was already reclaimed", () => {
    recordQueuedSend("nonce-1", "conv-left");
    useComposerStore.getState().stashFailedSend(
      "assistant-1",
      "conv-left",
      {
        content: "parked behind the running turn",
        attachments: [attachment],
      },
      "nonce-1",
    );
    useComposerStore.getState().takeFailedSend("assistant-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    publishStreamError("conv-left", "nonce-1");

    expect(heldFor("conv-left")).toBeUndefined();
    expect(stillQueued("nonce-1")).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  test("the conversation a mounted chat view handles keeps its held send for that view", () => {
    // That view's error handler owns this failure whether or not an optimistic
    // row survived to name it, and reads the copy itself, so taking it here
    // would leave that handler with nothing.
    useConversationStore.getState().setStreamHandledConversationId("conv-open");
    recordQueuedSend("nonce-1", "conv-open");
    render(<QueuedSendRecoveryWatcher />);

    publishStreamError("conv-open", "nonce-1");

    expect(stillQueued("nonce-1")).toBe(true);
    expect(heldFor("conv-open")).toBeUndefined();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test("the active conversation with no chat view mounted gets its message back here", () => {
    // The standalone document route keeps the active conversation id but
    // mounts no chat view for it, so no handler but this one sees the failure.
    useConversationStore.getState().setStreamHandledConversationId(null);
    recordQueuedSend("nonce-1", "conv-open");
    render(<QueuedSendRecoveryWatcher />);

    publishStreamError("conv-open", "nonce-1");

    expect(heldFor("conv-open")).toEqual({
      content: "parked behind the running turn",
      attachments: [attachment],
    });
    expect(stillQueued("nonce-1")).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  test("a chat view mounted for another conversation leaves this one to the watcher", () => {
    useConversationStore
      .getState()
      .setStreamHandledConversationId("conv-other");
    recordQueuedSend("nonce-1", "conv-open");
    render(<QueuedSendRecoveryWatcher />);

    publishStreamError("conv-open", "nonce-1");

    expect(heldFor("conv-open")).toBeDefined();
    expect(stillQueued("nonce-1")).toBe(false);
  });

  test("a deleted queued message lets the client copy go", () => {
    // It never runs, so no failure is coming for it and nothing is owed to the
    // conversation it was written in.
    recordQueuedSend("nonce-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    publishMessageQueuedDeleted("conv-left", "nonce-1");

    expect(stillQueued("nonce-1")).toBe(false);
    expect(heldFor("conv-left")).toBeUndefined();
  });

  test("a deletion carrying no nonce names no send to let go", () => {
    recordQueuedSend("nonce-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    publishMessageQueuedDeleted("conv-left");

    expect(stillQueued("nonce-1")).toBe(true);
  });

  test("a nonce naming no held send is another client's message", () => {
    recordQueuedSend("nonce-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    publishStreamError("conv-left", "nonce-other");

    expect(stillQueued("nonce-1")).toBe(true);
    expect(heldFor("conv-left")).toBeUndefined();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test("an error scoped to the turn answers for no one send", () => {
    recordQueuedSend("nonce-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    publishStreamError("conv-left", "nonce-1", "turn");

    expect(stillQueued("nonce-1")).toBe(true);
    expect(heldFor("conv-left")).toBeUndefined();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test("an echo carrying no nonce names no send to let go", () => {
    recordQueuedSend("nonce-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    publishUserMessageEcho("conv-left");

    expect(stillQueued("nonce-1")).toBe(true);
  });

  test("events of every other kind are left alone", () => {
    recordQueuedSend("nonce-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    act(() => {
      publish("sse.event", {
        id: "evt-complete",
        emittedAt: new Date().toISOString(),
        message: { type: "message_complete", conversationId: "conv-left" },
      });
    });

    expect(stillQueued("nonce-1")).toBe(true);
    expect(heldFor("conv-left")).toBeUndefined();
  });
});
