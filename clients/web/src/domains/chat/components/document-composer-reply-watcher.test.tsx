/**
 * Tests for `DocumentComposerReplyWatcher`, the always-mounted watcher that
 * raises the document composer's "Assistant replied" toast.
 *
 * The pending sends are driven straight through
 * `document-composer-reply-store` rather than by running a real send, so
 * these tests pin the watcher's own filtering (which stream events it treats
 * as terminal for a send) independently of `useDocumentComposerSubmit`,
 * whose hand-off to the store is covered by its own test file. The event bus,
 * the store, `useComposerStore`, and `useConversationStore` are real; only
 * navigation and the toast surface are mocked.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";

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
const toastErrorMock = mock((..._args: unknown[]) => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    info: (..._args: unknown[]) => {},
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
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
    queuePosition?: number;
  }>;
  processing?: boolean;
}
let fetchConversationMessagesMock = mock(
  async (..._args: unknown[]): Promise<ConversationSnapshot> => ({
    messages: [],
    processing: false,
  }),
);
mock.module("@/domains/chat/api/messages", () => ({
  ...realMessages,
  fetchConversationMessages: (...args: unknown[]) =>
    fetchConversationMessagesMock(...args),
}));

const { useComposerStore } = await import("@/domains/chat/composer-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { heldMessageFor, useDocumentComposerReplyStore } =
  await import("@/domains/chat/document-composer-reply-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { publish } = await import("@/lib/event-bus");
const { DocumentComposerReplyWatcher } =
  await import("@/domains/chat/components/document-composer-reply-watcher");

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

function publishStreamError(
  conversationId: string | undefined,
  clientMessageId?: string,
  scope?: "message" | "turn",
) {
  act(() => {
    publish("sse.event", {
      id: `evt-error-${conversationId ?? "none"}`,
      emittedAt: new Date().toISOString(),
      message:
        scope === "message" && conversationId
          ? {
              type: "message_failed",
              message: "Something went wrong.",
              conversationId,
              requestId: `req-${conversationId}`,
              ...(clientMessageId ? { clientMessageId } : {}),
            }
          : {
              type: "error",
              message: "Something went wrong.",
              ...(conversationId ? { conversationId } : {}),
              ...(clientMessageId ? { clientMessageId } : {}),
              ...(scope ? { scope } : {}),
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
  position = 1,
) {
  act(() => {
    publish("sse.event", {
      id: `evt-queued-${conversationId}`,
      emittedAt: new Date().toISOString(),
      message: {
        type: "message_queued",
        conversationId,
        requestId: `req-${conversationId}`,
        position,
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

function publishUserMessageEcho(
  conversationId: string | undefined,
  clientMessageId?: string,
  serverMessageId?: string,
) {
  act(() => {
    publish("sse.event", {
      id: `evt-echo-${conversationId ?? "none"}`,
      emittedAt: new Date().toISOString(),
      message: {
        type: "user_message_echo",
        text: "A note from the document composer.",
        ...(conversationId ? { conversationId } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(serverMessageId ? { requestId: serverMessageId } : {}),
      },
    });
  });
}

/**
 * Put a listed send in the state the daemon's echo leaves it in: taken in and
 * running, which is the only state a terminal settles.
 */
function acknowledgeRunning(conversationId: string, clientMessageId?: string) {
  useDocumentComposerReplyStore
    .getState()
    .markReplyRunning(conversationId, clientMessageId, true);
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

function acknowledgedFlags(conversationId: string): boolean[] {
  return (
    useDocumentComposerReplyStore
      .getState()
      .pendingReplies.get(conversationId)
      ?.map((pending) => pending.acknowledged) ?? []
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

function handedOff(conversationId: string): boolean {
  return useDocumentComposerReplyStore
    .getState()
    .handedOffConversationIds.has(conversationId);
}

function handedOffCount(): number {
  return useDocumentComposerReplyStore.getState().handedOffConversationIds.size;
}

/** The draft and the uploaded attachment a document send carried. */
const FAILED_SEND_PAYLOAD = {
  assistantId: "assistant-1",
  surfaceId: "surf-1",
  content: "a note on the draft",
  attachments: [
    {
      id: "srv-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      previewUrl: null,
    },
  ],
};

function documentInput(): string {
  return useComposerStore.getState().documentInput;
}

function documentAttachments() {
  return useComposerStore.getState().documentAttachments;
}

/** The message held for `surfaceId` under the assistant the sends went to,
 *  for the composer panel to take back. */
function heldFor(surfaceId: string) {
  return heldMessageFor(
    useDocumentComposerReplyStore.getState(),
    "assistant-1",
    surfaceId,
  );
}

/** The message an assistant switch detached from the send `clientMessageId`. */
function detachedFor(clientMessageId: string) {
  return useDocumentComposerReplyStore
    .getState()
    .detachedSends.get(clientMessageId);
}

function detachedQueuedFor(clientMessageId: string) {
  return useDocumentComposerReplyStore
    .getState()
    .detachedQueuedSends.get(clientMessageId);
}

beforeEach(() => {
  useDocumentComposerReplyStore.setState({
    pendingReplies: new Map(),
    failedSends: new Map(),
    claimedFailedSendBatches: new Map(),
    activeDocumentComposer: null,
    detachedSends: new Map(),
    detachedQueuedSends: new Map(),
    handedOffConversationIds: new Set(),
  });
  useConversationStore.setState({
    processingConversationIds: new Set(),
    processingSnapshots: new Map(),
    draftConversationIds: new Set(),
  });
  useComposerStore.setState({
    documentInput: "",
    documentAttachments: [],
    documentAttachmentLastError: null,
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  navigateSpy.mockClear();
  navigateToConversationMock.mockClear();
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
  fetchConversationMessagesMock = mock(
    async (..._args: unknown[]): Promise<ConversationSnapshot> => ({
      messages: [],
      processing: false,
    }),
  );
});

afterEach(() => {
  cleanup();
});

describe("DocumentComposerReplyWatcher", () => {
  test("a message_complete for a watched conversation toasts and stops watching", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    acknowledgeRunning("conv-1");
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
    acknowledgeRunning("conv-1");
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
    acknowledgeRunning("conv-1");
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
    acknowledgeRunning("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageComplete("conv-unrelated");

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);
  });

  test("ignores an aux-source message_complete for a watched conversation", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    acknowledgeRunning("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageComplete("conv-1", "aux");

    expect(toastSuccessMock).not.toHaveBeenCalled();
    // Still watching: the real reply has not arrived yet.
    expect(awaiting("conv-1")).toBe(true);
  });

  test("ignores a message_complete carrying no conversation id", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    acknowledgeRunning("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageComplete(undefined);

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);
  });

  test("a cancelled generation ends the wait without a toast", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    acknowledgeRunning("conv-1");
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
    acknowledgeRunning("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishGenerationCancelled("conv-unrelated");

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);
  });

  test("a conversation error ends the wait without a toast", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    acknowledgeRunning("conv-1");
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
    acknowledgeRunning("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishConversationError("conv-unrelated");

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);
  });

  test("a terminal stream error ends the wait without a toast", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    acknowledgeRunning("conv-1");
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
    acknowledgeRunning("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishConversationError("conv-1");
    // A turn the user started afterward, which this composer sent nothing
    // toward, completes normally.
    publishMessageComplete("conv-1");

    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("ignores an error carrying no conversation id", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    acknowledgeRunning("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishStreamError(undefined);

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);
  });

  test("a handoff answers the send that was running", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    acknowledgeRunning("conv-1");
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishGenerationHandoff("conv-1");

    // The daemon emits a handoff in place of `message_complete` when the turn
    // finishes with more messages queued behind it, so the reply is done.
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(awaiting("conv-1")).toBe(false);
    // The queued message the handoff announced is about to run, whether or
    // not this composer sent it, so the conversation is still busy.
    expect(processing("conv-1")).toBe(true);
  });

  test("the follow-up's own terminal takes down the activity a handoff left up", () => {
    // GIVEN the only document send in the conversation, running, with an
    // ordinary chat message queued behind it
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    acknowledgeRunning("conv-1");
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishGenerationHandoff("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(awaiting("conv-1")).toBe(false);
    expect(processing("conv-1")).toBe(true);

    // The queued message's own turn ends. On the standalone document route no
    // chat view is mounted to end that turn, so the marker the handoff left
    // up is this watcher's to take down, and there is no reply of this
    // composer's to announce.
    publishMessageComplete("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(processing("conv-1")).toBe(false);
  });

  test("a follow-up that hands off in turn keeps the activity up", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    acknowledgeRunning("conv-1");
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishGenerationHandoff("conv-1");
    // The message that ran next has one of its own queued behind it.
    publishGenerationHandoff("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(processing("conv-1")).toBe(true);

    publishMessageComplete("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(processing("conv-1")).toBe(false);
  });

  test("a terminal for a turn no handoff announced leaves the activity alone", () => {
    // GIVEN an activity this composer never raised and no send of its own
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageComplete("conv-1");

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(processing("conv-1")).toBe(true);
  });

  test("a handoff keeps the activity up for a document send still queued", () => {
    // GIVEN a running send and a second one parked behind it
    useDocumentComposerReplyStore
      .getState()
      .startAwaitingReply("conv-1", "cm-1");
    useDocumentComposerReplyStore
      .getState()
      .startAwaitingReply("conv-1", "cm-2");
    acknowledgeRunning("conv-1", "cm-1");
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageQueued("conv-1", "cm-2");
    publishGenerationHandoff("conv-1");

    // The handoff answered the running send; the queued one is still owed a
    // reply and holds the activity.
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(oldestNonce("conv-1")).toBe("cm-2");
    expect(processing("conv-1")).toBe(true);

    publishMessageDequeued("conv-1", "cm-2");
    publishMessageComplete("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(2);
    expect(awaiting("conv-1")).toBe(false);
    expect(processing("conv-1")).toBe(false);
  });

  test("a deleted queued send leaves up the marker a handoff left standing", () => {
    // GIVEN a running send and a second one parked behind it, with an
    // ordinary message queued behind them both
    useDocumentComposerReplyStore
      .getState()
      .startAwaitingReply("conv-1", "cm-1");
    useDocumentComposerReplyStore
      .getState()
      .startAwaitingReply("conv-1", "cm-2");
    acknowledgeRunning("conv-1", "cm-1");
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageQueued("conv-1", "cm-2");
    publishGenerationHandoff("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(handedOff("conv-1")).toBe(true);
    expect(processing("conv-1")).toBe(true);

    // WHEN the queued document send is discarded before it ever runs, so no
    // send of this composer's is left listed
    publishMessageQueuedDeleted("conv-1", "cm-2");

    // THEN the ordinary message the handoff announced is still running under
    // the marker it was left
    expect(awaiting("conv-1")).toBe(false);
    expect(processing("conv-1")).toBe(true);

    publishMessageComplete("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(processing("conv-1")).toBe(false);
    expect(handedOffCount()).toBe(0);
  });

  test("a queued send the daemon could not persist leaves that marker up too", () => {
    useDocumentComposerReplyStore
      .getState()
      .startAwaitingReply("conv-1", "cm-1");
    useDocumentComposerReplyStore
      .getState()
      .startAwaitingReply("conv-1", "cm-2", FAILED_SEND_PAYLOAD);
    acknowledgeRunning("conv-1", "cm-1");
    useConversationStore.getState().addProcessingConversationId("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishMessageQueued("conv-1", "cm-2");
    publishGenerationHandoff("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(handedOff("conv-1")).toBe(true);

    // WHEN the daemon reports it could not persist the queued send
    publishStreamError("conv-1", "cm-2", "message");

    // THEN that send's failure is reported and its message held for the
    // document it was composed for, while the ordinary message the handoff
    // announced keeps the marker up
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(heldFor("surf-1")).toEqual(FAILED_SEND_PAYLOAD);
    expect(awaiting("conv-1")).toBe(false);
    expect(processing("conv-1")).toBe(true);

    publishMessageComplete("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(processing("conv-1")).toBe(false);
    expect(handedOffCount()).toBe(0);
  });

  test("a handoff keeps a queued send waiting for the queue's own turn", () => {
    useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
    useDocumentComposerReplyStore.getState().markReplyQueued("conv-1");
    render(<DocumentComposerReplyWatcher />);

    publishGenerationHandoff("conv-1");

    // The turn that finished is the one this send sits behind in the queue.
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(awaiting("conv-1")).toBe(true);

    publishMessageDequeued("conv-1");
    publishMessageComplete("conv-1");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(awaiting("conv-1")).toBe(false);
  });

  describe("before the daemon acknowledges a send", () => {
    const terminals: [string, (conversationId: string) => void][] = [
      ["message_complete", publishMessageComplete],
      ["generation_handoff", publishGenerationHandoff],
      ["generation_cancelled", publishGenerationCancelled],
      ["conversation_error", publishConversationError],
    ];

    for (const [name, publishTerminal] of terminals) {
      test(`${name} settles no send the daemon has not spoken for`, () => {
        // GIVEN a send listed before its POST reached the daemon
        useDocumentComposerReplyStore
          .getState()
          .startAwaitingReply("conv-1", "cm-1");
        useConversationStore.getState().addProcessingConversationId("conv-1");
        render(<DocumentComposerReplyWatcher />);

        // WHEN a turn already running in the conversation ends
        publishTerminal("conv-1");

        // THEN it answered none of this composer's sends
        expect(toastSuccessMock).not.toHaveBeenCalled();
        expect(awaiting("conv-1")).toBe(true);
        expect(processing("conv-1")).toBe(true);
      });
    }

    test("an echo retracts the recovery from an abandoned ambiguous request", () => {
      const replyStore = useDocumentComposerReplyStore.getState();
      replyStore.startAwaitingReply(
        "conv-1",
        "cm-1",
        FAILED_SEND_PAYLOAD,
      );
      replyStore.markReplyRecovering("conv-1", "cm-1");
      replyStore.stashFailedSend(FAILED_SEND_PAYLOAD, "cm-1");
      const recovered = replyStore.takeFailedSend("assistant-1", "surf-1");
      if (recovered === null) {
        throw new Error("expected a recovered document send");
      }
      useComposerStore.getState().setInput(recovered.content, "document");
      useComposerStore
        .getState()
        .restoreAttachmentsIfEmpty(recovered.attachments, "document");
      replyStore.setActiveDocumentComposer("assistant-1", "surf-1");
      render(<DocumentComposerReplyWatcher />);

      publishUserMessageEcho("conv-1", "cm-1");

      expect(heldFor("surf-1")).toBeUndefined();
      expect(documentInput()).toBe("");
      expect(documentAttachments()).toEqual([]);
      expect(
        useDocumentComposerReplyStore.getState().claimedFailedSendBatches.size,
      ).toBe(0);
      expect(
        useDocumentComposerReplyStore
          .getState()
          .pendingReplies.get("conv-1")?.[0]?.acknowledged,
      ).toBe(true);
    });

    test("a late echo leaves a recovered document payload the user edited", () => {
      const replyStore = useDocumentComposerReplyStore.getState();
      replyStore.startAwaitingReply(
        "conv-1",
        "cm-1",
        FAILED_SEND_PAYLOAD,
      );
      replyStore.markReplyRecovering("conv-1", "cm-1");
      replyStore.stashFailedSend(FAILED_SEND_PAYLOAD, "cm-1");
      replyStore.takeFailedSend("assistant-1", "surf-1");
      useComposerStore
        .getState()
        .setInput("edited recovered note", "document");
      replyStore.setActiveDocumentComposer("assistant-1", "surf-1");
      render(<DocumentComposerReplyWatcher />);

      publishUserMessageEcho("conv-1", "cm-1");

      expect(documentInput()).toBe("edited recovered note");
      expect(
        useDocumentComposerReplyStore.getState().claimedFailedSendBatches.size,
      ).toBe(0);
    });

    test("a definitive failure does not hold a shown recovery a second time", () => {
      const replyStore = useDocumentComposerReplyStore.getState();
      replyStore.startAwaitingReply(
        "conv-1",
        "cm-1",
        FAILED_SEND_PAYLOAD,
      );
      replyStore.markReplyRecovering("conv-1", "cm-1");
      replyStore.stashFailedSend(FAILED_SEND_PAYLOAD, "cm-1");
      const recovered = replyStore.takeFailedSend("assistant-1", "surf-1");
      if (recovered === null) {
        throw new Error("expected a recovered document send");
      }
      useComposerStore.getState().setInput(recovered.content, "document");
      useComposerStore
        .getState()
        .restoreAttachmentsIfEmpty(recovered.attachments, "document");
      replyStore.setActiveDocumentComposer("assistant-1", "surf-1");
      render(<DocumentComposerReplyWatcher />);

      publishStreamError("conv-1", "cm-1", "message");

      expect(documentInput()).toBe(FAILED_SEND_PAYLOAD.content);
      expect(documentAttachments()).toHaveLength(1);
      expect(heldFor("surf-1")).toBeUndefined();
      expect(
        useDocumentComposerReplyStore.getState().claimedFailedSendBatches.size,
      ).toBe(0);
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
    });

    test("the echo makes the send settleable by its own turn's terminal", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishUserMessageEcho("conv-1", "cm-1");
      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("an echo naming another client's message acknowledges nothing", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishUserMessageEcho("conv-1", "cm-someone-else");

      expect(acknowledgedFlags("conv-1")).toEqual([false]);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(awaiting("conv-1")).toBe(true);
    });

    test("an echo carrying no nonce acknowledges the oldest send only", () => {
      useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
      useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
      render(<DocumentComposerReplyWatcher />);

      // An older daemon echoes the send back without `clientMessageId`.
      publishUserMessageEcho("conv-1");

      expect(acknowledgedFlags("conv-1")).toEqual([true, false]);

      publishMessageComplete("conv-1");

      // The second send is still waiting on an echo of its own.
      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(acknowledgedFlags("conv-1")).toEqual([false]);
    });

    test("an echo carrying no conversation id is ignored", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishUserMessageEcho(undefined, "cm-1");

      expect(acknowledgedFlags("conv-1")).toEqual([false]);
    });

    test("the queue ack acknowledges the send it parks", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-1");

      expect(acknowledgedFlags("conv-1")).toEqual([true]);
      expect(queuedFlags("conv-1")).toEqual([true]);

      publishMessageDequeued("conv-1", "cm-1");
      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("an echo for a send already running leaves it as it is", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-1");
      publishMessageDequeued("conv-1", "cm-1");
      publishUserMessageEcho("conv-1", "cm-1");

      expect(queuedFlags("conv-1")).toEqual([false]);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
    });
  });

  describe("sends in order", () => {
    test("one terminal answers every send the daemon dequeued together", () => {
      // GIVEN two sends the daemon parked and then took off the queue into a
      // single turn
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-1");
      publishMessageQueued("conv-1", "cm-2", 2);
      publishMessageDequeued("conv-1", "cm-1");
      publishMessageDequeued("conv-1", "cm-2");

      expect(queuedFlags("conv-1")).toEqual([false, false]);

      publishMessageComplete("conv-1");

      // THEN that turn answered both of them, and announced itself once
      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
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
      acknowledgeRunning("conv-1", "cm-1");
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
      acknowledgeRunning("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueuedDeleted("conv-1", "cm-2");

      // The first send is still running, so the activity stays up.
      expect(nonces("conv-1")).toEqual(["cm-1"]);
      expect(processing("conv-1")).toBe(true);
    });

    test("a cancelled first turn still leaves the queued send its toast", () => {
      // GIVEN a running send and a second one parked behind it
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      acknowledgeRunning("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-2");
      publishGenerationCancelled("conv-1");

      // The cancelled turn was the running send's, and it has nothing to
      // announce; the queued one is still owed a reply.
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(oldestNonce("conv-1")).toBe("cm-2");
      expect(processing("conv-1")).toBe(true);

      publishMessageDequeued("conv-1", "cm-2");
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
      test(`${name} for the turn ahead settles nothing, and the queued send toasts on its own turn`, () => {
        useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
        useDocumentComposerReplyStore.getState().markReplyQueued("conv-1");
        useConversationStore.getState().addProcessingConversationId("conv-1");
        render(<DocumentComposerReplyWatcher />);

        publishTerminal("conv-1");

        // The turn that ended is the one the queued message sits behind, so
        // the wait, its queued flag, and the activity all stay up.
        expect(toastSuccessMock).not.toHaveBeenCalled();
        expect(awaiting("conv-1")).toBe(true);
        expect(queued("conv-1")).toBe(true);
        expect(processing("conv-1")).toBe(true);

        publishMessageDequeued("conv-1");
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
      publishMessageDequeued("conv-1");
      publishConversationError("conv-1");

      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("a send queued at position 2 waits out both turns ahead of it", () => {
      // GIVEN a send parked behind two turns it cannot be batched with
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-1", 2);

      // Both turns ahead of it end without this send ever running.
      publishGenerationHandoff("conv-1");
      publishMessageComplete("conv-1");

      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(queued("conv-1")).toBe(true);
      expect(processing("conv-1")).toBe(true);

      publishMessageDequeued("conv-1", "cm-1");
      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
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

    test("a legacy error recovers a dequeued send that never echoed", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1");
      publishMessageDequeued("conv-1");
      publishStreamError("conv-1");

      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
      expect(heldFor("surf-1")).toEqual(FAILED_SEND_PAYLOAD);
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
      expect(toastSuccessMock).not.toHaveBeenCalled();
    });

    test("a legacy error does not recover a dequeued send that persisted", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      useDocumentComposerReplyStore
        .getState()
        .recordReplyServerMessageId("conv-1", "cm-1", "req-conv-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1");
      publishMessageDequeued("conv-1");
      publishUserMessageEcho("conv-1", undefined, "req-conv-1");
      publishStreamError("conv-1");

      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
      expect(heldFor("surf-1")).toBeUndefined();
      expect(toastErrorMock).not.toHaveBeenCalled();
      expect(toastSuccessMock).not.toHaveBeenCalled();
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

    test("a nonce-less message_requeued re-flags the send the dequeue started", () => {
      // GIVEN a daemon that echoes no nonce on its queue events
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      publishMessageQueued("conv-1", undefined, 2);
      publishMessageDequeued("conv-1");

      expect(queuedFlags("conv-1")).toEqual([false, true]);

      publishMessageRequeued("conv-1");

      // THEN the send the dequeue started is queued again, and the one behind
      // it stays where it was
      expect(queuedFlags("conv-1")).toEqual([true, true]);
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

    test("a rolled-back dequeue leaves the competing turn's terminal alone", () => {
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

      publishMessageDequeued("conv-1", "cm-1");
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

    test("a nonce-less queued deletion settles by its server request id", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .recordReplyServerMessageId("conv-1", "cm-1", "req-conv-1");
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueuedDeleted("conv-1");

      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
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

      publishMessageDequeued("conv-1", "cm-1");
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

      publishMessageDequeued("conv-1", "cm-1");
      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
    });
  });

  describe("an error that names a message", () => {
    test("drops only the send carrying the nonce", () => {
      // GIVEN two sends the daemon dequeued into one turn
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      acknowledgeRunning("conv-1", "cm-1");
      acknowledgeRunning("conv-1", "cm-2");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      // WHEN the daemon reports a failure for the second one alone
      publishStreamError("conv-1", "cm-2");

      // THEN only that send ends, silently, and the turn still running for
      // the first one keeps the activity up
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(nonces("conv-1")).toEqual(["cm-1"]);
      expect(processing("conv-1")).toBe(true);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("settles nothing when the nonce names no pending send", () => {
      // GIVEN one send running in the conversation
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      acknowledgeRunning("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      // WHEN another client's message is the one that failed
      publishStreamError("conv-1", "cm-someone-else");

      // THEN this send is untouched and still owed its reply
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(nonces("conv-1")).toEqual(["cm-1"]);
      expect(processing("conv-1")).toBe(true);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("an error naming no message ends every send running", () => {
      // GIVEN two sends running in one turn
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      acknowledgeRunning("conv-1", "cm-1");
      acknowledgeRunning("conv-1", "cm-2");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      // WHEN the turn itself fails
      publishStreamError("conv-1");

      // THEN both sends end, silently
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("drops a send the daemon could not persist from the queue", () => {
      // GIVEN a running send and a second one parked behind it
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      acknowledgeRunning("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-1", "cm-2");

      // WHEN the queued send fails before any turn runs it
      publishStreamError("conv-1", "cm-2");

      // THEN it is gone, since no reply is coming for it
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(nonces("conv-1")).toEqual(["cm-1"]);
      expect(processing("conv-1")).toBe(true);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });
  });

  describe("an error scoped to a message", () => {
    test("settles nothing when the scope names no send", () => {
      // GIVEN two sends the daemon dequeued into one turn
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-2");
      acknowledgeRunning("conv-1", "cm-1");
      acknowledgeRunning("conv-1", "cm-2");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      // WHEN a legacy client's batch member fails, so nothing names which
      publishStreamError("conv-1", undefined, "message");

      // THEN the turn runs on, and both sends are still owed their terminals
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(nonces("conv-1")).toEqual(["cm-1", "cm-2"]);
      expect(processing("conv-1")).toBe(true);

      publishMessageComplete("conv-1");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
    });

    test("settles nothing when the nonce names another client's message", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      acknowledgeRunning("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishStreamError("conv-1", "cm-someone-else", "message");

      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(nonces("conv-1")).toEqual(["cm-1"]);
      expect(processing("conv-1")).toBe(true);
    });
  });

  describe("a document send the daemon could not persist", () => {
    test("a definitive failure keeps one ambiguous recovery copy", () => {
      const replyStore = useDocumentComposerReplyStore.getState();
      replyStore.startAwaitingReply(
        "conv-1",
        "cm-1",
        FAILED_SEND_PAYLOAD,
      );
      replyStore.markReplyRecovering("conv-1", "cm-1");
      replyStore.stashFailedSend(FAILED_SEND_PAYLOAD, "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishStreamError("conv-1", "cm-1", "message");

      expect(heldFor("surf-1")).toEqual(FAILED_SEND_PAYLOAD);
      expect(awaiting("conv-1")).toBe(false);
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
    });

    test("reports the failure and holds the message for its document", () => {
      // GIVEN a send running in the conversation, listed with the message it
      // carried, on a composer its own success path already cleared
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      acknowledgeRunning("conv-1", "cm-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      // WHEN the daemon reports it could not persist that message
      publishStreamError("conv-1", "cm-1", "message");

      // THEN the wait and its marker are down, the user is told the send
      // failed, and the message waits under the document it was composed for
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
      expect(toastErrorMock.mock.calls[0]?.[0]).toBe(
        "Couldn't send your message. Try again.",
      );
      expect(heldFor("surf-1")).toEqual(FAILED_SEND_PAYLOAD);
    });

    test("writes no composer slot of its own", () => {
      // The watcher outlives every document host and knows nothing about
      // which document is on screen, so the panel showing `surf-1` is what
      // takes the message back.
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      acknowledgeRunning("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishStreamError("conv-1", "cm-1", "message");

      expect(documentInput()).toBe("");
      expect(documentAttachments()).toHaveLength(0);
    });

    test("leaves a draft the user has typed since alone", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      acknowledgeRunning("conv-1", "cm-1");
      useComposerStore.getState().setInput("the next message", "document");
      render(<DocumentComposerReplyWatcher />);

      publishStreamError("conv-1", "cm-1", "message");

      // The failure is still worth reporting, but the newer draft is the one
      // the user is writing.
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
      expect(documentInput()).toBe("the next message");
    });

    test("leaves attachments the user has staged since alone", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      acknowledgeRunning("conv-1", "cm-1");
      useComposerStore.setState({
        documentAttachments: [
          {
            kind: "uploaded",
            localId: "a-newer",
            id: "srv-newer",
            filename: "newer.txt",
            mimeType: "text/plain",
            sizeBytes: 3,
            previewUrl: null,
          },
        ],
      });
      render(<DocumentComposerReplyWatcher />);

      publishStreamError("conv-1", "cm-1", "message");

      expect(toastErrorMock).toHaveBeenCalledTimes(1);
      expect(documentAttachments()).toHaveLength(1);
      expect(documentAttachments()[0]).toMatchObject({ id: "srv-newer" });
    });

    test("reports a send listed without its message, holding nothing", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1");
      acknowledgeRunning("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishStreamError("conv-1", "cm-1", "message");

      expect(awaiting("conv-1")).toBe(false);
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
      expect(useDocumentComposerReplyStore.getState().failedSends.size).toBe(0);
      expect(documentInput()).toBe("");
      expect(documentAttachments()).toHaveLength(0);
    });

    test("says nothing about another client's failed message", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      acknowledgeRunning("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      publishStreamError("conv-1", "cm-someone-else", "message");

      expect(nonces("conv-1")).toEqual(["cm-1"]);
      expect(toastErrorMock).not.toHaveBeenCalled();
      expect(useDocumentComposerReplyStore.getState().failedSends.size).toBe(0);
      expect(documentInput()).toBe("");
      expect(documentAttachments()).toHaveLength(0);
    });
  });

  describe("a send listed under the key it went out with", () => {
    test("the echo moves the send onto the row it names", () => {
      // GIVEN a legacy send listed under the client key its POST went out
      // with, before the response names the row the daemon minted
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("draft-key", "cm-1");
      useConversationStore.getState().addProcessingConversationId("draft-key");
      render(<DocumentComposerReplyWatcher />);

      // WHEN the daemon echoes the send back under that row
      publishUserMessageEcho("conv-server", "cm-1");

      // THEN the wait and its marker moved, and the send is running there
      expect(awaiting("draft-key")).toBe(false);
      expect(processing("draft-key")).toBe(false);
      expect(nonces("conv-server")).toEqual(["cm-1"]);
      expect(acknowledgedFlags("conv-server")).toEqual([true]);
      expect(processing("conv-server")).toBe(true);

      // The turn's terminal reaches the send it now stands under.
      publishMessageComplete("conv-server");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-server")).toBe(false);
      expect(processing("conv-server")).toBe(false);
    });

    test("the queue ack moves the send and parks it", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("draft-key", "cm-1");
      useConversationStore.getState().addProcessingConversationId("draft-key");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueued("conv-server", "cm-1");

      expect(awaiting("draft-key")).toBe(false);
      expect(nonces("conv-server")).toEqual(["cm-1"]);
      expect(queuedFlags("conv-server")).toEqual([true]);
      expect(processing("conv-server")).toBe(true);

      publishMessageDequeued("conv-server", "cm-1");
      publishMessageComplete("conv-server");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-server")).toBe(false);
      expect(processing("conv-server")).toBe(false);
    });

    test("a deletion moves the send and ends its wait", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("draft-key", "cm-1");
      useConversationStore.getState().addProcessingConversationId("draft-key");
      render(<DocumentComposerReplyWatcher />);

      publishMessageQueuedDeleted("conv-server", "cm-1");

      // The message never runs, so no reply is coming for it under either id.
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(awaiting("draft-key")).toBe(false);
      expect(awaiting("conv-server")).toBe(false);
      expect(processing("draft-key")).toBe(false);
      expect(processing("conv-server")).toBe(false);
    });

    test("a scoped error moves the send and ends only that one", () => {
      // GIVEN a send already running on the row, and a second listed under
      // the key its own POST went out with
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-server", "cm-0");
      acknowledgeRunning("conv-server", "cm-0");
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("draft-key", "cm-1");
      useConversationStore.getState().addProcessingConversationId("draft-key");
      render(<DocumentComposerReplyWatcher />);

      publishStreamError("conv-server", "cm-1", "message");

      // THEN the moved send ends silently and the running one keeps the
      // activity up
      expect(toastSuccessMock).not.toHaveBeenCalled();
      expect(awaiting("draft-key")).toBe(false);
      expect(nonces("conv-server")).toEqual(["cm-0"]);
      expect(processing("conv-server")).toBe(true);

      publishMessageComplete("conv-server");

      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
      expect(awaiting("conv-server")).toBe(false);
      expect(processing("conv-server")).toBe(false);
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

    test("leaving the assistant drops the wait and its marker", () => {
      useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
      acknowledgeRunning("conv-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      // Logging out, removing the selected paired assistant, and the
      // lifecycle reset all leave no assistant active.
      setActiveAssistant(null);

      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);

      // Coming back to the same assistant leaves the wait dropped, so a
      // terminal for conv-1 belongs to some unrelated turn.
      setActiveAssistant("assistant-1");
      publishMessageComplete("conv-1");

      expect(toastSuccessMock).not.toHaveBeenCalled();
    });

    test("switching drops the marker a handoff left up", () => {
      useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
      acknowledgeRunning("conv-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

      publishGenerationHandoff("conv-1");

      // The handoff answered the only send and left the marker up for the
      // queued work it announced, so nothing is pending under conv-1.
      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(true);
      expect(handedOff("conv-1")).toBe(true);

      setActiveAssistant("assistant-2");

      // The queued work's terminal rides the detached connection, so nothing
      // is left to take the marker down.
      expect(processing("conv-1")).toBe(false);
      expect(handedOffCount()).toBe(0);
    });

    test("switching to another assistant keeps held messages and a send's own", () => {
      // GIVEN a message held for its document, and a send the daemon has not
      // spoken for, whose POST may still be out
      useDocumentComposerReplyStore
        .getState()
        .stashFailedSend(FAILED_SEND_PAYLOAD);
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", {
          ...FAILED_SEND_PAYLOAD,
          surfaceId: "surf-2",
        });
      render(<DocumentComposerReplyWatcher />);

      setActiveAssistant("assistant-2");

      // THEN the held message still waits for its document's composer under
      // the assistant it went to, and the send's message is kept under its
      // nonce for that POST to hand back if it throws
      expect(awaiting("conv-1")).toBe(false);
      expect(heldFor("surf-1")).toEqual(FAILED_SEND_PAYLOAD);
      expect(detachedFor("cm-1")).toEqual({
        ...FAILED_SEND_PAYLOAD,
        surfaceId: "surf-2",
      });
    });

    test("an idle snapshot keeps an accepted send retractable through its handoff gap", async () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      setActiveAssistant("assistant-2");
      expect(detachedQueuedFor("cm-1")).toEqual({
        conversationId: "conv-1",
        payload: FAILED_SEND_PAYLOAD,
      });

      setActiveAssistant("assistant-1");

      await waitFor(() =>
        expect(fetchConversationMessagesMock).toHaveBeenCalledWith(
          "assistant-1",
          "conv-1",
        ),
      );
      expect(detachedQueuedFor("cm-1")).toBeDefined();
      expect(awaiting("conv-1")).toBe(true);
      expect(heldFor("surf-1")).toEqual(FAILED_SEND_PAYLOAD);
      expect(processing("conv-1")).toBe(false);
      expect(toastErrorMock).toHaveBeenCalledTimes(1);

      publishUserMessageEcho("conv-1", "cm-1");

      expect(detachedQueuedFor("cm-1")).toBeUndefined();
      expect(heldFor("surf-1")).toBeUndefined();
      expect(awaiting("conv-1")).toBe(true);
      expect(processing("conv-1")).toBe(true);
    });

    test("a later queued snapshot retracts the provisional recovery", async () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      setActiveAssistant("assistant-2");
      setActiveAssistant("assistant-1");

      await waitFor(() => expect(heldFor("surf-1")).toEqual(FAILED_SEND_PAYLOAD));
      expect(processing("conv-1")).toBe(false);

      fetchConversationMessagesMock = mock(
        async (..._args: unknown[]): Promise<ConversationSnapshot> => ({
          messages: [
            {
              id: "req-1",
              clientMessageId: "cm-1",
              role: "user",
              timestamp: new Date().toISOString(),
              attachments: [],
              queueStatus: "queued",
              queuePosition: 1,
            },
          ],
          processing: true,
        }),
      );
      setActiveAssistant("assistant-2");
      setActiveAssistant("assistant-1");

      await waitFor(() => expect(heldFor("surf-1")).toBeUndefined());
      expect(detachedQueuedFor("cm-1")).toBeDefined();
      expect(awaiting("conv-1")).toBe(true);
      expect(queued("conv-1")).toBe(true);
      expect(processing("conv-1")).toBe(true);
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
    });

    test("a late failure from the detached stream recovers its queued send", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      setActiveAssistant("assistant-2");
      publishStreamError("conv-1", "cm-1", "message");

      expect(detachedQueuedFor("cm-1")).toBeUndefined();
      expect(heldFor("surf-1")).toEqual(FAILED_SEND_PAYLOAD);
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
    });

    test("a late queue acknowledgment does not discard a detached send", () => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      setActiveAssistant("assistant-2");
      publishMessageQueued("conv-1", "cm-1");

      expect(detachedQueuedFor("cm-1")).toBeDefined();
      expect(awaiting("conv-1")).toBe(false);
    });

    test("switching back discards recovery when history contains the send", async () => {
      fetchConversationMessagesMock = mock(
        async (..._args: unknown[]): Promise<ConversationSnapshot> => ({
          messages: [
            {
              id: "msg-1",
              clientMessageId: "cm-1",
              role: "user",
              timestamp: new Date().toISOString(),
              attachments: [],
            },
          ],
          processing: false,
        }),
      );
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      setActiveAssistant("assistant-2");
      setActiveAssistant("assistant-1");

      await waitFor(() => expect(detachedQueuedFor("cm-1")).toBeUndefined());
      expect(awaiting("conv-1")).toBe(false);
      expect(heldFor("surf-1")).toBeUndefined();
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    test("switching back recognizes a persisted send without a client nonce", async () => {
      fetchConversationMessagesMock = mock(
        async (..._args: unknown[]): Promise<ConversationSnapshot> => ({
          messages: [
            {
              id: "req-1",
              role: "user",
              timestamp: new Date().toISOString(),
              attachments: [],
            },
          ],
          processing: false,
        }),
      );
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued("conv-1", "cm-1");
      useDocumentComposerReplyStore
        .getState()
        .recordReplyServerMessageId("conv-1", "cm-1", "req-1");
      render(<DocumentComposerReplyWatcher />);

      setActiveAssistant("assistant-2");
      setActiveAssistant("assistant-1");

      await waitFor(() => expect(detachedQueuedFor("cm-1")).toBeUndefined());
      expect(awaiting("conv-1")).toBe(false);
      expect(heldFor("surf-1")).toBeUndefined();
      expect(processing("conv-1")).toBe(false);
      expect(toastErrorMock).not.toHaveBeenCalled();
    });

    test("switching back keeps a send that the snapshot still lists as queued", async () => {
      fetchConversationMessagesMock = mock(
        async (..._args: unknown[]): Promise<ConversationSnapshot> => ({
          messages: [
            {
              id: "req-1",
              clientMessageId: "cm-1",
              role: "user",
              timestamp: new Date().toISOString(),
              attachments: [],
              queueStatus: "queued",
              queuePosition: 1,
            },
          ],
          processing: true,
        }),
      );
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      setActiveAssistant("assistant-2");
      setActiveAssistant("assistant-1");

      await waitFor(() =>
        expect(fetchConversationMessagesMock).toHaveBeenCalledWith(
          "assistant-1",
          "conv-1",
        ),
      );
      expect(awaiting("conv-1")).toBe(true);
      expect(queued("conv-1")).toBe(true);
      expect(detachedQueuedFor("cm-1")).toBeDefined();

      publishMessageDequeued("conv-1", "cm-1");

      expect(detachedQueuedFor("cm-1")).toBeUndefined();
      expect(queued("conv-1")).toBe(false);
    });

    test("switching back keeps a persisted send while its turn is processing", async () => {
      fetchConversationMessagesMock = mock(
        async (..._args: unknown[]): Promise<ConversationSnapshot> => ({
          messages: [
            {
              id: "msg-1",
              clientMessageId: "cm-1",
              role: "user",
              timestamp: new Date().toISOString(),
              attachments: [],
            },
          ],
          processing: true,
        }),
      );
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", FAILED_SEND_PAYLOAD);
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued("conv-1", "cm-1");
      render(<DocumentComposerReplyWatcher />);

      setActiveAssistant("assistant-2");
      setActiveAssistant("assistant-1");

      await waitFor(() => expect(detachedQueuedFor("cm-1")).toBeUndefined());
      expect(awaiting("conv-1")).toBe(true);
      expect(queued("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(true);

      publishMessageComplete("conv-1");

      expect(awaiting("conv-1")).toBe(false);
      expect(processing("conv-1")).toBe(false);
      expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    });

    test("leaving every assistant drops held messages and a send's own", () => {
      useDocumentComposerReplyStore
        .getState()
        .stashFailedSend(FAILED_SEND_PAYLOAD);
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-1", "cm-1", {
          ...FAILED_SEND_PAYLOAD,
          surfaceId: "surf-2",
        });
      render(<DocumentComposerReplyWatcher />);

      // Logging out and removing the active assistant leave no assistant
      // active, and one user's message must not reach the next context.
      setActiveAssistant(null);

      expect(awaiting("conv-1")).toBe(false);
      expect(heldFor("surf-1")).toBeUndefined();
      expect(detachedFor("cm-1")).toBeUndefined();
    });

    test("selecting the first assistant leaves the wait alone", () => {
      useResolvedAssistantsStore.setState({ activeAssistantId: null });
      useDocumentComposerReplyStore.getState().startAwaitingReply("conv-1");
      acknowledgeRunning("conv-1");
      useConversationStore.getState().addProcessingConversationId("conv-1");
      render(<DocumentComposerReplyWatcher />);

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
