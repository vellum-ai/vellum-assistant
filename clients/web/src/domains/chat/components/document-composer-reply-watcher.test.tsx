/**
 * Tests for `DocumentComposerReplyWatcher`, the always-mounted watcher that
 * raises the document composer's "Assistant replied" toast.
 *
 * The awaiting set is driven straight through
 * `document-composer-reply-store` rather than by running a real send, so
 * these tests pin the watcher's own filtering (which `message_complete`
 * events it acts on) independently of `useDocumentComposerSubmit`, whose
 * hand-off to the store is covered by its own test file. The event bus, the
 * store, and `useConversationStore` are real; only navigation and the toast
 * surface are mocked.
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
});
