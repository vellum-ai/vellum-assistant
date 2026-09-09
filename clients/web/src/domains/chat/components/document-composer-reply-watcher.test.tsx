/**
 * Tests for `DocumentComposerReplyWatcher`, the always-mounted watcher that
 * raises the document composer's "Assistant replied" toast.
 *
 * The pending sends are driven straight through
 * `document-composer-reply-store` rather than by running a real send, so
 * these tests pin the watcher's own filtering (which stream events it treats
 * as terminal for a send) independently of `useDocumentComposerSubmit`,
 * whose hand-off to the store is covered by its own test file. The event bus,
 * the store, and `useConversationStore` are real; only navigation and the
 * toast surface are mocked.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";

const navigateSpy = mock((_to: string) => {});
mock.module("react-router", () => ({
  useNavigate: () => navigateSpy,
}));

const navigateToConversationMock = mock((..._args: unknown[]) => {});
mock.module("@/utils/conversation-navigation", () => ({
  navigateToConversation: (...args: unknown[]) =>
    navigateToConversationMock(...args),
}));

const toastSuccessMock = mock((..._args: unknown[]) => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    info: (..._args: unknown[]) => {},
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (..._args: unknown[]) => {},
  },
}));

const { useConversationStore } = await import("@/stores/conversation-store");
const { useDocumentComposerReplyStore } = await import(
  "@/domains/chat/document-composer-reply-store"
);
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);
const { publish } = await import("@/lib/event-bus");
const { DocumentComposerReplyWatcher } = await import(
  "@/domains/chat/components/document-composer-reply-watcher"
);

function publishMessageComplete(
  conversationId: string | undefined,
  source?: "main" | "aux",
) {
  act(() => {
    publish("sse.event", {
      id: `evt-${conversationId ?? "none"}`,
      emittedAt: new Date().toISOString(),
      message: {
        type: "message_complete",
        ...(conversationId ? { conversationId } : {}),
        ...(source ? { source } : {}),
      },
    });
  });
}

function publishGenerationCancelled(conversationId: string) {
  act(() => {
    publish("sse.event", {
      id: `evt-cancelled-${conversationId}`,
      emittedAt: new Date().toISOString(),
      message: { type: "generation_cancelled", conversationId },
    });
  });
}

function publishConversationError(conversationId: string) {
  act(() => {
    publish("sse.event", {
      id: `evt-conv-error-${conversationId}`,
      emittedAt: new Date().toISOString(),
      message: {
        type: "conversation_error",
        conversationId,
        code: "PROVIDER_API",
        userMessage: "The provider failed.",
        retryable: true,
      },
    });
  });
}

function publishStreamError(conversationId: string | undefined) {
  act(() => {
    publish("sse.event", {
      id: `evt-error-${conversationId ?? "none"}`,
      emittedAt: new Date().toISOString(),
      message: {
        type: "error",
        message: "Something went wrong.",
        ...(conversationId ? { conversationId } : {}),
      },
    });
  });
}

function publishGenerationHandoff(conversationId: string) {
  act(() => {
    publish("sse.event", {
      id: `evt-handoff-${conversationId}`,
      emittedAt: new Date().toISOString(),
      message: { type: "generation_handoff", conversationId, queuedCount: 1 },
    });
  });
}

function publishMessageQueued(
  conversationId: string,
  clientMessageId?: string,
) {
  act(() => {
    publish("sse.event", {
      id: `evt-queued-${conversationId}`,
      emittedAt: new Date().toISOString(),
      message: {
        type: "message_queued",
        conversationId,
        requestId: `req-${conversationId}`,
        position: 1,
        ...(clientMessageId ? { clientMessageId } : {}),
      },
    });
  });
}

function publishMessageDequeued(
  conversationId: string,
  clientMessageId?: string,
) {
  act(() => {
    publish("sse.event", {
      id: `evt-dequeued-${conversationId}`,
      emittedAt: new Date().toISOString(),
      message: {
        type: "message_dequeued",
        conversationId,
        requestId: `req-${conversationId}`,
        ...(clientMessageId ? { clientMessageId } : {}),
      },
    });
  });
}

function publishMessageRequeued(
  conversationId: string,
  clientMessageId?: string,
) {
  act(() => {
    publish("sse.event", {
      id: `evt-requeued-${conversationId}`,
      emittedAt: new Date().toISOString(),
      message: {
        type: "message_requeued",
        conversationId,
        requestId: `req-${conversationId}`,
        position: 1,
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

function setActiveAssistant(assistantId: string | null) {
  act(() => {
    useResolvedAssistantsStore.getState().setActiveAssistantId(assistantId);
  });
}

function awaiting(conversationId: string): boolean {
  return useDocumentComposerReplyStore
    .getState()
    .pendingReplies.has(conversationId);
}

function queued(conversationId: string): boolean {
  return (
    useDocumentComposerReplyStore
      .getState()
      .pendingReplies.get(conversationId)
      ?.some((pending) => pending.queued) ?? false
  );
}

function queuedFlags(conversationId: string): boolean[] {
  return (
    useDocumentComposerReplyStore
      .getState()
      .pendingReplies.get(conversationId)
      ?.map((pending) => pending.queued) ?? []
  );
}

function nonces(conversationId: string): (string | undefined)[] {
  return (
    useDocumentComposerReplyStore
      .getState()
      .pendingReplies.get(conversationId)
      ?.map((pending) => pending.clientMessageId) ?? []
  );
}

function oldestNonce(conversationId: string): string | undefined {
  return useDocumentComposerReplyStore
    .getState()
    .pendingReplies.get(conversationId)?.[0]?.clientMessageId;
}

function processing(conversationId: string): boolean {
  return useConversationStore
    .getState()
    .processingConversationIds.has(conversationId);
}

beforeEach(() => {
  useDocumentComposerReplyStore.setState({ pendingReplies: new Map() });
  useConversationStore.setState({
    processingConversationIds: new Set(),
    processingSnapshots: new Map(),
    draftConversationIds: new Set(),
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  navigateSpy.mockClear();
  navigateToConversationMock.mockClear();
  toastSuccessMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("DocumentComposerReplyWatcher", () => {
  test("a message_complete for a watched conversation toasts and stops watching", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageComplete("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock.mock.calls[0]?.[0]).toBe("Assistant replied");
    expect(
      useConversationStore.getState().processingConversationIds.has("conv-1"),
    ).toBe(false);
    // The wait is over: a second turn completing in the same conversation is
    // no longer this composer's reply to announce.
    expect(awaiting("conv-1")).toBe(false);
  });

  test("the toast's action navigates to the conversation that replied", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageComplete("conv-1");

    const options = toastSuccessMock.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    expect(navigateToConversationMock).toHaveBeenCalledWith(
      navigateSpy,
      "conv-1",
    );
  });

  test("the toast's action is inert once another assistant is active", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageComplete("conv-1");

    const options = toastSuccessMock.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
    options.action.onClick();

    // conv-1 belongs to the assistant that replied, so selecting it under a
    // different one would open the wrong conversation.
    expect(navigateToConversationMock).not.toHaveBeenCalled();
  });

  test("ignores a message_complete for a conversation nobody is waiting on", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageComplete("conv-unrelated");

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);
  });

  test("ignores an aux-source message_complete for a watched conversation", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageComplete("conv-1", "aux");

    expect(toastSuccessMock).not.toHaveBeenCalled();
    // Still watching: the real reply has not arrived yet.
    expect(awaiting("conv-1")).toBe(true);
  });

  test("ignores a message_complete carrying no conversation id", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageComplete(undefined);

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);
  });

  test("a cancelled generation ends the wait without a toast", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishGenerationCancelled("conv-1");

    // There is no reply to announce, and nothing is left waiting for one.
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(false);
    expect(
      useConversationStore.getState().processingConversationIds.has("conv-1"),
    ).toBe(false);
  });

  test("a cancelled generation for an unwatched conversation is ignored", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishGenerationCancelled("conv-unrelated");

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);
  });

  test("a conversation error ends the wait without a toast", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishConversationError("conv-1");

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(false);
    expect(
      useConversationStore.getState().processingConversationIds.has("conv-1"),
    ).toBe(false);
  });

  test("a conversation error for an unwatched conversation is ignored", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishConversationError("conv-unrelated");

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);
  });

  test("a terminal stream error ends the wait without a toast", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishStreamError("conv-1");

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(false);
    expect(
      useConversationStore.getState().processingConversationIds.has("conv-1"),
    ).toBe(false);
  });

  test("a later turn in a failed conversation does not toast in the reply's place", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishConversationError("conv-1");
    // A turn the user started afterward, which this composer sent nothing
    // toward, completes normally.
    publishMessageComplete("conv-1");

    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("ignores an error carrying no conversation id", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishStreamError(undefined);

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);
  });

  test("a handoff answers the send that was running", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishGenerationHandoff("conv-1");

    // The daemon emits a handoff in place of `message_complete` when the turn
    // finishes with more messages queued behind it, so the reply is done.
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(awaiting("conv-1")).toBe(false);
    expect(processing("conv-1")).toBe(false);
  });

  test("a handoff keeps a queued send waiting for the queue's own turn", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    useDocumentComposerReplyStore.getState().markReplyQueued("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishGenerationHandoff("conv-1");

    // The turn that finished belongs to a message queued ahead of this one.
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);

    publishMessageComplete("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(awaiting("conv-1")).toBe(false);
  });

  describe("sends in order", () => {
    test("each terminal settles one send, oldest first", () => {
      // GIVEN a second document composer send into a conversation whose first
      // send is still running
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageComplete("conv-1");

      // THEN the first send has its reply, and the second is still owed one
      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(oldestNonce("conv-1")).toBe("cm-2");
      expect(processing("conv-1")).toBe(true);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(2);
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("a send queued behind the running one toasts on its own turn", () => {
      // GIVEN the daemon parking the second send behind the first
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-2");

      // THEN only the send the ack names is flagged
      expect(queuedFlags("conv-1")).toEqual([false, true]);

      publishGenerationHandoff("conv-1");

      // The first send's turn handed off with the second still queued.
      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(oldestNonce("conv-1")).toBe("cm-2");
      expect(processing("conv-1")).toBe(true);

      publishMessageDequeued("conv-1", "cm-2");

      expect(queuedFlags("conv-1")).toEqual([false]);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(2);
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("a message_queued naming neither send flags nothing", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-someone-else");

      expect(queuedFlags("conv-1")).toEqual([false, false]);
    });

    test("a message_queued carrying no nonce flags the newest send", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      render(<DocumentComposerReplyWatcher />);

      // An older daemon acks the queue without echoing `clientMessageId`, and
      // the send that just went out is the one it parked.
      publishMessageQueued("conv-1");

      expect(queuedFlags("conv-1")).toEqual([false, true]);
    });

    test("a message_queued_deleted removes only the send it names", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueuedDeleted("conv-1", "cm-2");

      // The first send is still running, so the activity stays up.
      expect(nonces("conv-1")).toEqual(["cm-1"]);
      expect(processing("conv-1")).toBe(true);
    });

    test("a cancelled first turn still leaves the second send its toast", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishGenerationCancelled("conv-1");

      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(oldestNonce("conv-1")).toBe("cm-2");
      expect(processing("conv-1")).toBe(true);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });
  });

  describe("a wait queued behind a running turn", () => {
    const terminals: [string, (conversationId: string) => void][] = [
      ["generation_handoff", publishGenerationHandoff],
      ["generation_cancelled", publishGenerationCancelled],
      ["error", publishStreamError],
      ["conversation_error", publishConversationError],
    ];

    for (const [name, publishTerminal] of terminals) {
      test(`${name} for the running turn is absorbed, and the queued message's reply toasts`, () => {
        useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
        useDocumentComposerReplyStore.getState().markReplyQueued("conv-1");
        useConversationStore.getState().addProcessingConversationId("conv-1");
        render(<DocumentComposerReplyWatcher />);

        publishTerminal("conv-1");

        // The turn that ended is the one the queued message sits behind, so
        // the wait and the activity it drives both stay up.
        expect(toastSuccessMock).not.toHaveBeenCalled();
        expect(awaiting("conv-1")).toBe(true);
        expect(queued("conv-1")).toBe(false);
        expect(processing("conv-1")).toBe(true);

        publishMessageComplete("conv-1");

        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        expect(awaiting("conv-1")).toBe(false);
        expect(processing("conv-1")).toBe(false);
      });
    }

    test("the queued message's own failure ends the wait silently", () => {
      useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
      useDocumentComposerReplyStore.getState().markReplyQueued("conv-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishGenerationCancelled("conv-1");
      publishConversationError("conv-1");

      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });
  });

  describe("the daemon's queue events", () => {
    test("a message_queued naming the awaited send flags the wait", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-1");

      expect(queued("conv-1")).toBe(true);
      expect(awaiting("conv-1")).toBe(true);
    });

    test("a message_queued naming another client's message is ignored", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-someone-else");

      expect(queued("conv-1")).toBe(false);
      expect(awaiting("conv-1")).toBe(true);
    });

    test("a message_queued carrying no nonce flags by conversation", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      // An older daemon acks the queue without echoing `clientMessageId`.
      publishMessageQueued("conv-1");

      expect(queued("conv-1")).toBe(true);
    });

    test("a message_queued for a conversation nobody is waiting on starts no wait", () => {
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-unrelated", "cm-1");

      expect(awaiting("conv-unrelated")).toBe(false);
      expect(queued("conv-unrelated")).toBe(false);
    });

    test("a message_dequeued unflags the wait without ending it", () => {
      useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
      useDocumentComposerReplyStore.getState().markReplyQueued("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageDequeued("conv-1");

      expect(queued("conv-1")).toBe(false);
      expect(awaiting("conv-1")).toBe(true);
    });

    test("a message_requeued for the awaited send re-flags the wait a dequeue cleared", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-1");
      publishMessageDequeued("conv-1");

      expect(queued("conv-1")).toBe(false);

      publishMessageRequeued("conv-1", "cm-1");

      expect(queued("conv-1")).toBe(true);
      expect(awaiting("conv-1")).toBe(true);
    });

    test("a message_requeued naming another client's message is ignored", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageRequeued("conv-1", "cm-someone-else");

      expect(queued("conv-1")).toBe(false);
      expect(awaiting("conv-1")).toBe(true);
    });

    test("a rolled-back dequeue leaves the competing turn's terminal absorbed", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-1");
      publishMessageDequeued("conv-1");
      publishMessageRequeued("conv-1", "cm-1");

      expect(queued("conv-1")).toBe(true);

      // The turn that retook the processing lock finishes first.
      publishGenerationHandoff("conv-1");

      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(awaiting("conv-1")).toBe(true);
      expect(processing("conv-1")).toBe(true);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("a message_queued_deleted naming the awaited send ends the wait silently", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueuedDeleted("conv-1", "cm-1");

      // The message never runs, so no reply is coming for it.
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("a message_queued_deleted naming another message leaves the wait up", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueuedDeleted("conv-1", "cm-someone-else");

      expect(awaiting("conv-1")).toBe(true);
      expect(processing("conv-1")).toBe(true);
    });

    test("a message_queued_deleted naming no message leaves the wait up", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueuedDeleted("conv-1");

      expect(awaiting("conv-1")).toBe(true);
    });

    test("the queue ack flags the wait ahead of the running turn's handoff", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-1");
      publishGenerationHandoff("conv-1");

      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(awaiting("conv-1")).toBe(true);
      expect(processing("conv-1")).toBe(true);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("the queue ack carries the wait through the running turn failing", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-1");
      publishGenerationCancelled("conv-1");

      // The cancelled turn is the one the awaited message sits behind; the
      // daemon still drains the queue and runs it.
      expect(awaiting("conv-1")).toBe(true);
      expect(processing("conv-1")).toBe(true);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
    });
  });

  describe("assistant switches", () => {
    test("switching to another assistant drops the wait", () => {
      useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      setActiveAssistant("assistant-2");

      expect(awaiting("conv-1")).toBe(false);
      // The outgoing assistant's stream is detached, so no terminal is coming
      // to take the activity down with the wait.
      expect(processing("conv-1")).toBe(false);

      // A terminal seen for conv-1 afterwards belongs to some unrelated turn.
      publishMessageComplete("conv-1");

      expect(toastSuccessMock).not.toHaveBeenCalled();
    });

    test("a pass through no active assistant leaves the wait up", () => {
      useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      // A reload drops the active id before settling on the same assistant.
      setActiveAssistant(null);
      setActiveAssistant("assistant-1");

      expect(awaiting("conv-1")).toBe(true);
      expect(processing("conv-1")).toBe(true);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    });

    test("a switch by way of no active assistant drops the wait", () => {
      useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
      render(<DocumentComposerReplyWatcher />);

      setActiveAssistant(null);
      setActiveAssistant("assistant-2");

      expect(awaiting("conv-1")).toBe(false);
    });

    test("an unmounted watcher leaves the wait alone", () => {
      useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
      const { unmount } = render(<DocumentComposerReplyWatcher />);

      unmount();
      setActiveAssistant("assistant-2");

      expect(awaiting("conv-1")).toBe(true);
    });
  });
});
