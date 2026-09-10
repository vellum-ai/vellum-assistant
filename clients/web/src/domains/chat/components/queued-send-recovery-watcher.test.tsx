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
import { act, cleanup, render } from "@testing-library/react";

const toastErrorMock = mock((..._args: unknown[]) => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    info: (..._args: unknown[]) => {},
    success: (..._args: unknown[]) => {},
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

const { useComposerStore } = await import("@/domains/chat/composer-store");
const { useConversationStore } = await import("@/stores/conversation-store");
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
      message: {
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

function heldFor(conversationId: string) {
  return useComposerStore
    .getState()
    .failedSendsByConversation.get(conversationId);
}

function stillQueued(clientMessageId: string): boolean {
  return useComposerStore.getState().queuedSends.has(clientMessageId);
}

beforeEach(() => {
  useComposerStore.setState({
    queuedSends: new Map(),
    failedSendsByConversation: new Map(),
  });
  useConversationStore.getState().reset();
  useConversationStore.getState().setActiveConversationId("conv-open");
  toastErrorMock.mockClear();
});

afterEach(() => {
  cleanup();
  useComposerStore.setState({
    queuedSends: new Map(),
    failedSendsByConversation: new Map(),
  });
});

describe("QueuedSendRecoveryWatcher", () => {
  test("the daemon's echo lets the client copy go", () => {
    recordQueuedSend("nonce-1", "conv-left");
    render(<QueuedSendRecoveryWatcher />);

    publishUserMessageEcho("conv-left", "nonce-1");

    expect(stillQueued("nonce-1")).toBe(false);
    // The message is persisted, so nothing is owed to that conversation.
    expect(heldFor("conv-left")).toBeUndefined();
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
