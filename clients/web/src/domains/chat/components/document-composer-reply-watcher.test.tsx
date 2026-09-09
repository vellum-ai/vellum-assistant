/**
 * Tests for `DocumentComposerReplyWatcher`, the always-mounted watcher that
 * raises the document composer's "Assistant replied" toast.
 *
 * The awaiting set is driven straight through
 * `document-composer-reply-store` rather than by running a real send, so
 * these tests pin the watcher's own filtering (which stream events it treats
 * as terminal for the wait) independently of `useDocumentComposerSubmit`,
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

function awaiting(conversationId: string): boolean {
  return useDocumentComposerReplyStore
    .getState()
    .awaitingReplyConversationIds.has(conversationId);
}

beforeEach(() => {
  useDocumentComposerReplyStore.setState({
    awaitingReplyConversationIds: new Set(),
  });
  useConversationStore.setState({
    processingConversationIds: new Set(),
    processingSnapshots: new Map(),
    draftConversationIds: new Set(),
  });
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

  test("a handoff keeps the wait open until the queue's own turn completes", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishGenerationHandoff("conv-1");

    // The turn that finished belongs to a message queued ahead of this one.
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);

    publishMessageComplete("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(awaiting("conv-1")).toBe(false);
  });
});
