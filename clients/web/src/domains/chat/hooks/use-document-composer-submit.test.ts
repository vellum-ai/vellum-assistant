/**
 * Tests for `useDocumentComposerSubmit`, the pinned document composer's
 * submit logic. Covers the conversation-id resolution branches (existing /
 * cached / fresh-mint, with and without server-side minting), the snapshot
 * passed to the sidebar's processing tracking, the success and failure
 * paths, the empty-content/uploading guards, and the hand-off of the
 * conversation to watch for a reply to `document-composer-reply-store`.
 * Also covers the queued-send result, the idempotency nonce carried on the
 * POST, when the wait for a reply is raised and taken back down, and the
 * guard that keeps a late-resolving send from clearing a draft typed for a
 * document, or an assistant, it was never about. Also covers dropping a send
 * whose assistant changed while it was resolving, and the refused document
 * link that stops the first turn from running without the document. Ownership
 * covers the round trip too (away to another assistant and back), alongside
 * the full slot reset that frees the composer's preview URLs and the
 * "View conversation" action going quiet under another assistant. The version
 * the send is framed against is covered as well: the wait for an identity
 * that has not hydrated, and a version that flips mid-flight failing the send
 * rather than posting under a frame the row was never minted for.
 *
 * The "Assistant replied" toast that hand-off leads to belongs to
 * `DocumentComposerReplyWatcher` and is covered by its own test file.
 *
 * `postChatMessage`, `conversationsPost` and `documentsByIdConversationsPost`
 * are mocked (network); `edit-chat-session` (sessionStorage) and the
 * composer/conversation/reply stores are real, so the resolution branches are
 * exercised for real rather than asserted against a mock's call args.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import type { PostMessageResult } from "@/domains/chat/api/messages";
import type { ComposerSlot } from "@/domains/chat/composer-store";
import type { DocumentConversationRef } from "@/domains/chat/utils/document-conversation";

const realMessages = await import("@/domains/chat/api/messages");
// Echoes back the conversation id it was sent (the real server's contract
// for the non-mint path), or "conv-1" when sent `null` (the server-mint
// path's "assistant, mint one" request): a stand-in for a freshly minted
// id, distinct from whatever draft id the caller resolved locally.
async function defaultPostChatMessage(
  ..._args: unknown[]
): Promise<PostMessageResult> {
  const conversationId = (_args[1] as string | null) ?? "conv-1";
  return {
    ok: true,
    assistantId: "assistant-1",
    conversationId,
    messageId: "msg-1",
  };
}
let postChatMessageMock = mock(defaultPostChatMessage);

/**
 * The order network calls land in, across mocks. The fix this file guards
 * turns on ordering: the conversation row and the document link both have to
 * exist before the message that starts the first turn goes out.
 */
const callOrder: string[] = [];

mock.module("@/domains/chat/api/messages", () => ({
  ...realMessages,
  postChatMessage: (...args: unknown[]) => {
    callOrder.push("postChatMessage");
    return postChatMessageMock(...(args as []));
  },
}));

const MINTED_CONVERSATION_ID = "conv-server-minted";

const documentsByIdConversationsPostMock = mock(
  async (..._args: unknown[]) => ({
    data: { success: true },
  }),
);
interface MintedConversationResult {
  data: {
    id: string;
    conversationKey: string;
    conversationType: string;
    created: boolean;
  };
}
async function defaultConversationsPost(
  ..._args: unknown[]
): Promise<MintedConversationResult> {
  return {
    data: {
      id: MINTED_CONVERSATION_ID,
      conversationKey: MINTED_CONVERSATION_ID,
      conversationType: "standard",
      created: true,
    },
  };
}
let conversationsPostMock = mock(defaultConversationsPost);
mock.module("@/generated/daemon/sdk.gen", () => ({
  documentsByIdConversationsPost: (...args: unknown[]) => {
    callOrder.push("documentsByIdConversationsPost");
    return documentsByIdConversationsPostMock(...(args as []));
  },
  conversationsPost: (...args: unknown[]) => {
    callOrder.push("conversationsPost");
    return conversationsPostMock(...(args as []));
  },
}));

const navigateSpy = mock((_to: string) => {});
mock.module("react-router", () => ({
  useNavigate: () => navigateSpy,
}));

const navigateToConversationMock = mock((..._args: unknown[]) => {});
mock.module("@/utils/conversation-navigation", () => ({
  navigateToConversation: (...args: unknown[]) =>
    navigateToConversationMock(...args),
}));

const toastInfoMock = mock((..._args: unknown[]) => {});
const toastErrorMock = mock((..._args: unknown[]) => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    info: (...args: unknown[]) => toastInfoMock(...args),
    success: (..._args: unknown[]) => {},
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

const { useComposerStore } = await import("@/domains/chat/composer-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { getEditChatConversationId, setEditChatConversationId } =
  await import("@/utils/edit-chat-session");
const { conversationListQueryKey } =
  await import("@/utils/conversation-list-keys");
const { listPage } = await import("@/utils/conversation-list.test-helper");
const { useDocumentComposerReplyStore } =
  await import("@/domains/chat/document-composer-reply-store");
const { useViewerStore } = await import("@/stores/viewer-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { useDocumentComposerSubmit } =
  await import("./use-document-composer-submit");

const ASSISTANT_ID = "assistant-1";
const SURFACE_ID = "surf-1";

/**
 * Which slot-clearing action ran, and against which slot. The real actions
 * still run behind these, so the composer store behaves as it does in the app;
 * only the choice between them is observed. `fullReset` is the one that
 * revokes the slot's preview blob URLs.
 */
const composerResets: string[] = [];
const realResetAttachments = useComposerStore.getState().resetAttachments;
const realFullReset = useComposerStore.getState().fullReset;
useComposerStore.setState({
  resetAttachments: (slot?: ComposerSlot) => {
    composerResets.push(`resetAttachments:${slot ?? "main"}`);
    realResetAttachments(slot);
  },
  fullReset: (slot?: ComposerSlot) => {
    composerResets.push(`fullReset:${slot ?? "main"}`);
    realFullReset(slot);
  },
});

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

function renderSubmit(conversationId: string) {
  return renderHook(
    () =>
      useDocumentComposerSubmit({
        assistantId: ASSISTANT_ID,
        doc: { surfaceId: SURFACE_ID, conversationId },
      }),
    { wrapper },
  );
}

/** Renders against a swappable `doc`, for the mid-flight document switch. */
function renderSubmitFor(doc: DocumentConversationRef) {
  return renderHook(
    ({ doc: current }: { doc: DocumentConversationRef }) =>
      useDocumentComposerSubmit({ assistantId: ASSISTANT_ID, doc: current }),
    { wrapper, initialProps: { doc } },
  );
}

/** Renders against a swappable assistant, for the mid-flight switch. */
function renderSubmitForAssistant(
  assistantId: string,
  conversationId = "conv-a",
) {
  return renderHook(
    ({ assistantId: current }: { assistantId: string }) =>
      useDocumentComposerSubmit({
        assistantId: current,
        doc: { surfaceId: SURFACE_ID, conversationId },
      }),
    { wrapper, initialProps: { assistantId } },
  );
}

/**
 * Points `postChatMessage` at a promise the test resolves by hand, so a send
 * can be left in flight while the surface underneath it changes.
 */
function deferPostChatMessage(): (result: PostMessageResult) => void {
  let settle: (result: PostMessageResult) => void = () => {};
  const pending = new Promise<PostMessageResult>((resolve) => {
    settle = resolve;
  });
  postChatMessageMock = mock(async (..._args: unknown[]) => pending);
  return (result) => settle(result);
}

/** Points `postChatMessage` at a promise the test rejects by hand. */
function failPostChatMessage(): () => void {
  let fail: () => void = () => {};
  const pending = new Promise<PostMessageResult>((_resolve, reject) => {
    fail = () => reject(new Error("network dropped"));
  });
  postChatMessageMock = mock(async (..._args: unknown[]) => pending);
  return fail;
}

/** Points the conversation mint at a promise the test resolves by hand. */
function deferConversationsPost(): () => void {
  let settle: () => void = () => {};
  const pending = new Promise<MintedConversationResult>((resolve) => {
    settle = () => resolve(defaultConversationsPost());
  });
  conversationsPostMock = mock(async (..._args: unknown[]) => pending);
  return settle;
}

/** Points the document link at a promise the test resolves by hand. */
function deferDocumentLink(): () => void {
  let settle: () => void = () => {};
  const pending = new Promise<{ data: { success: boolean } }>((resolve) => {
    settle = () => resolve({ data: { success: true } });
  });
  documentsByIdConversationsPostMock.mockImplementationOnce(
    async () => pending,
  );
  return settle;
}

function sentResult(conversationId: string): PostMessageResult {
  return {
    ok: true,
    assistantId: ASSISTANT_ID,
    conversationId,
    messageId: "msg-1",
  };
}

function sentOptions(callIndex: number): { clientMessageId?: string } {
  return (postChatMessageMock.mock.calls[callIndex]?.[3] ?? {}) as {
    clientMessageId?: string;
  };
}

function isAwaitingReply(conversationId: string): boolean {
  return useDocumentComposerReplyStore
    .getState()
    .pendingReplies.has(conversationId);
}

function isProcessing(conversationId: string): boolean {
  return useConversationStore
    .getState()
    .processingConversationIds.has(conversationId);
}

function isQueuedReply(conversationId: string): boolean {
  const pending = useDocumentComposerReplyStore
    .getState()
    .pendingReplies.get(conversationId);
  return pending?.some((p) => p.queued) ?? false;
}

/** The nonce of the oldest send still awaiting a reply in `conversationId`. */
function awaitingNonce(conversationId: string): string | undefined {
  return useDocumentComposerReplyStore
    .getState()
    .pendingReplies.get(conversationId)?.[0]?.clientMessageId;
}

/** The document `document-viewer-page`'s "Submit Feedback" leaves open: on a
 *  draft conversation nothing has sent against yet. */
const OPENED_DRAFT_DOC = {
  source: "document",
  surfaceId: SURFACE_ID,
  conversationId: "conv-draft",
  documentName: "README.md",
  content: "# Hello",
} as const;

function openedConversationId(): string | null {
  const opened = useViewerStore.getState().openedDocumentState;
  return opened?.source === "document" ? opened.conversationId : null;
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  useComposerStore.setState({
    documentInput: "",
    documentAttachments: [],
    documentAttachmentLastError: null,
  });
  useConversationStore.setState({
    processingConversationIds: new Set(),
    processingSnapshots: new Map(),
    draftConversationIds: new Set(),
  });
  useDocumentComposerReplyStore.setState({ pendingReplies: new Map() });
  useViewerStore.setState({ openedDocumentState: null });
  // Below the server-mint floor, so the legacy path is the default and the
  // send's bounded wait for a resolved version settles immediately.
  useAssistantIdentityStore.setState({
    version: "0.8.5",
    assistantId: ASSISTANT_ID,
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
  composerResets.length = 0;
  window.sessionStorage.clear();
  postChatMessageMock = mock(defaultPostChatMessage);
  conversationsPostMock = mock(defaultConversationsPost);
  callOrder.length = 0;
  documentsByIdConversationsPostMock.mockClear();
  navigateSpy.mockClear();
  navigateToConversationMock.mockClear();
  toastInfoMock.mockClear();
  toastErrorMock.mockClear();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
  useDocumentComposerReplyStore.setState({ pendingReplies: new Map() });
  useViewerStore.setState({ openedDocumentState: null });
});

describe("conversation id resolution", () => {
  test("uses the document's own linked conversation, and never links it again", async () => {
    const { result } = renderSubmit("conv-existing");
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });

    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe("conv-existing");
    expect(documentsByIdConversationsPostMock).not.toHaveBeenCalled();
  });

  test("reuses the session-cached id when the document has none, and links it", async () => {
    setEditChatConversationId(ASSISTANT_ID, SURFACE_ID, "conv-cached");
    const { result } = renderSubmit("");
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });

    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe("conv-cached");
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(1);
  });

  test("mints and persists a fresh id when nothing is linked or cached, on an assistant without server-mint support", async () => {
    const { result } = renderSubmit("");
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });

    // No server-mint support (the assistant is below the mint floor): the
    // freshly minted draft id is sent directly as the wire `conversationId`.
    const sentConversationId = postChatMessageMock.mock.calls[0]?.[1] as string;
    expect(sentConversationId).toBeTruthy();
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(1);
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBe(
      sentConversationId,
    );
    expect(
      useConversationStore.getState().draftConversationIds.has(sentConversationId),
    ).toBe(false);
  });

  test("a fresh draft on a server-mint-capable assistant mints and links the conversation before it sends", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    // The session cache is written for real (sessionStorage), so its ordering
    // against the send shows up here rather than in `callOrder`.
    const cachedIdAtSend: (string | null)[] = [];
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => {
        cachedIdAtSend.push(
          getEditChatConversationId(ASSISTANT_ID, SURFACE_ID),
        );
        return defaultPostChatMessage(..._args);
      },
    );
    const { result } = renderSubmit("");
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });

    expect(conversationsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: ASSISTANT_ID },
      body: {},
      throwOnError: true,
    });
    // The daemon starts the agent loop inside the send and the active-document
    // injector reads the link during prompt assembly, so the row and the link
    // both exist before the first turn starts.
    expect(callOrder).toEqual([
      "conversationsPost",
      "documentsByIdConversationsPost",
      "postChatMessage",
    ]);
    expect(cachedIdAtSend[0]).toBe(MINTED_CONVERSATION_ID);
    // The send carries the minted id, not a null asking the daemon to mint.
    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe(MINTED_CONVERSATION_ID);
    // The minted id (not the local draft id) is what gets cached and linked.
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBe(
      MINTED_CONVERSATION_ID,
    );
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: ASSISTANT_ID, id: SURFACE_ID },
      body: { conversationId: MINTED_CONVERSATION_ID },
      throwOnError: true,
    });
    // The local draft mark is gone: nothing is left registered as an
    // unconfirmed client-side draft once the assistant has minted a row.
    expect(useConversationStore.getState().draftConversationIds.size).toBe(0);
    expect(
      useConversationStore
        .getState()
        .processingConversationIds.has(MINTED_CONVERSATION_ID),
    ).toBe(true);

    const options = toastInfoMock.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    expect(navigateToConversationMock).toHaveBeenCalledWith(
      navigateSpy,
      MINTED_CONVERSATION_ID,
    );
  });

  test("a cached (previously-sent) id is never treated as a fresh draft, even with server-mint support", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    setEditChatConversationId(ASSISTANT_ID, SURFACE_ID, "conv-cached");
    const { result } = renderSubmit("");
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });

    // Sent directly: a cached id is known-good, not a fresh draft, so it
    // never needs the mint branch regardless of assistant support.
    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe("conv-cached");
  });

  test("a retry after a failed send never reuses the prior attempt's dead draft id", async () => {
    let calls = 0;
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => {
        calls += 1;
        if (calls === 1) {
          return { ok: false, status: 500, error: { detail: "boom" } };
        }
        return defaultPostChatMessage(..._args);
      },
    );
    const { result } = renderSubmit("");
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.status).toBe("error");
    // Nothing was persisted after the failed attempt.
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBeNull();
    const firstAttemptId = postChatMessageMock.mock.calls[0]?.[1];

    // Retry: the draft was never cached, so this resolves a brand-new id
    // rather than resending the dead one from the failed attempt.
    useComposerStore.getState().setInput("hello", "document");
    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.status).toBe("sent");
    const secondAttemptId = postChatMessageMock.mock.calls[1]?.[1] as string;
    expect(secondAttemptId).toBeTruthy();
    expect(secondAttemptId).not.toBe(firstAttemptId);
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBe(
      secondAttemptId,
    );
  });
});

describe("the version the send is framed against", () => {
  test("a version that hydrates while the send waits takes the mint path", async () => {
    // GIVEN an identity store with no version yet, where a synchronous read
    // would report an assistant that cannot mint a conversation.
    useAssistantIdentityStore.setState({ version: null, assistantId: null });
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("");

    // WHEN the version hydrates past the mint floor while the send waits on it.
    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    act(() => {
      useAssistantIdentityStore.setState({
        version: "0.9.0",
        assistantId: ASSISTANT_ID,
      });
    });
    await act(async () => {
      await submitted;
    });

    // THEN the send is framed against the version that landed: the assistant
    // mints the row and the message goes out against it, rather than a
    // client-side draft id the daemon has never heard of.
    expect(conversationsPostMock).toHaveBeenCalledTimes(1);
    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe(MINTED_CONVERSATION_ID);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe("sent");
  });

  test("a version that flips while the document is being linked fails the send instead of posting a stale frame", async () => {
    // GIVEN an assistant below the mint floor, so the send is framed for the
    // legacy `conversationKey` path against a fresh client-minted draft id.
    const settleLink = deferDocumentLink();
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() =>
      expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(1),
    );

    // WHEN the version hydrates past the mint floor while the link is still
    // out, so `postChatMessage` would strict-lookup an id nothing minted.
    act(() => {
      useAssistantIdentityStore.setState({
        version: "0.9.0",
        assistantId: ASSISTANT_ID,
      });
    });
    await act(async () => {
      settleLink();
      await submitted;
    });

    // THEN nothing goes out, and nothing is left recorded against the id the
    // send was framed for.
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe(
      "Couldn't send your message. Try again.",
    );
    expect(result.current.status).toBe("error");
    expect(useDocumentComposerReplyStore.getState().pendingReplies.size).toBe(
      0,
    );
    expect(useConversationStore.getState().processingConversationIds.size).toBe(
      0,
    );
    expect(useComposerStore.getState().documentInput).toBe("hello");

    // The retry is framed against the version that landed, so it mints the row
    // and sends against that.
    await act(async () => {
      await result.current.submit();
    });

    expect(conversationsPostMock).toHaveBeenCalledTimes(1);
    expect(postChatMessageMock).toHaveBeenCalledTimes(1);
    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe(MINTED_CONVERSATION_ID);
    expect(result.current.status).toBe("sent");
  });
});

describe("send guards", () => {
  test("no-ops with an empty draft and no attachments", async () => {
    const { result } = renderSubmit("conv-1");

    await act(async () => {
      await result.current.submit();
    });

    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  test("no-ops while an attachment is still uploading", async () => {
    useComposerStore.setState({
      documentInput: "hello",
      documentAttachments: [
        {
          kind: "uploading",
          localId: "u1",
          filename: "f",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
      ],
    });
    const { result } = renderSubmit("conv-1");

    await act(async () => {
      await result.current.submit();
    });

    expect(postChatMessageMock).not.toHaveBeenCalled();
  });

  test("no-ops without an assistant id or a resolvable document", async () => {
    const { result } = renderHook(
      () => useDocumentComposerSubmit({ assistantId: null, doc: null }),
      { wrapper },
    );
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });

    expect(postChatMessageMock).not.toHaveBeenCalled();
  });
});

describe("success path", () => {
  test("clears the document slot, marks processing, and toasts a sent confirmation", async () => {
    useComposerStore.setState({
      documentInput: "hello",
      documentAttachments: [
        {
          kind: "uploaded",
          localId: "a1",
          id: "srv-1",
          filename: "f.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          previewUrl: null,
        },
      ],
    });
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    expect(postChatMessageMock).toHaveBeenCalledTimes(1);
    expect(postChatMessageMock.mock.calls[0]?.[2]).toBe("hello");
    expect(postChatMessageMock.mock.calls[0]?.[3]).toMatchObject({
      attachmentIds: ["srv-1"],
    });

    expect(useComposerStore.getState().documentInput).toBe("");
    expect(useComposerStore.getState().documentAttachments).toHaveLength(0);
    expect(
      useConversationStore
        .getState()
        .processingConversationIds.has("conv-existing"),
    ).toBe(true);
    expect(result.current.status).toBe("sent");
    expect(toastInfoMock).toHaveBeenCalledTimes(1);

    // Fires the "View conversation" toast action.
    const options = toastInfoMock.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    expect(navigateToConversationMock).toHaveBeenCalledWith(
      navigateSpy,
      "conv-existing",
    );
  });

  test("fully resets the document slot, so its preview URLs are revoked", async () => {
    const { result } = renderSubmit("conv-existing");
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });

    // Nothing on this surface renders a sent bubble, so the preview blob URLs
    // the slot created have no reader left once the message is away.
    expect(composerResets).toEqual(["fullReset:document"]);
    expect(useComposerStore.getState().documentInput).toBe("");
  });

  test("the View conversation action does nothing once another assistant is active", async () => {
    const { result } = renderSubmit("conv-existing");
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });

    const options = toastInfoMock.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    // The toast outlives a switch away from the assistant that sent, and the
    // row it points at belongs to that assistant alone.
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
    options.action.onClick();
    expect(navigateToConversationMock).not.toHaveBeenCalled();

    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    options.action.onClick();
    expect(navigateToConversationMock).toHaveBeenCalledWith(
      navigateSpy,
      "conv-existing",
    );
  });

  test("seeds the processing snapshot from the conversation's current latestAssistantMessageAt", async () => {
    queryClient.setQueryData(
      conversationListQueryKey(ASSISTANT_ID),
      listPage([
        {
          conversationId: "conv-existing",
          title: "t",
          createdAt: 1,
          lastMessageAt: 2,
          latestAssistantMessageAt: 555,
        },
      ]),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    expect(
      useConversationStore.getState().processingSnapshots.get("conv-existing"),
    ).toBe(555);
  });

  test("the Sent micro-state fades back to idle", async () => {
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.status).toBe("sent");

    await waitFor(() => expect(result.current.status).toBe("idle"), {
      timeout: 3000,
    });
  });

  test("hands the sent conversation to the reply watcher store", async () => {
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    // `DocumentComposerReplyWatcher` raises the "Assistant replied" toast off
    // this record, so it must outlive this hook's own mount.
    expect(isAwaitingReply("conv-existing")).toBe(true);
  });

  test("watches the conversation the send resolved, not the document's own", async () => {
    // A document with no linked conversation: the id worth watching only
    // exists once the send resolves one, and is not in any query cache.
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("");

    await act(async () => {
      await result.current.submit();
    });

    const conversationId = postChatMessageMock.mock.calls[0]?.[1] as string;
    expect(conversationId).toBeTruthy();
    expect(isAwaitingReply(conversationId)).toBe(true);
  });

  test("a failed send leaves nothing awaiting a reply", async () => {
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => ({
        ok: false,
        status: 500,
        error: { detail: "boom" },
      }),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    expect(isAwaitingReply("conv-existing")).toBe(false);
  });
});

describe("failure path", () => {
  test("a rejected send surfaces an error toast and leaves the draft untouched", async () => {
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => ({
        ok: false,
        status: 500,
        error: { detail: "Something broke" },
      }),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.status).toBe("error");
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe("Something broke");
    // Nothing was optimistically cleared, so there is nothing to restore.
    expect(useComposerStore.getState().documentInput).toBe("hello");
  });

  test("a failed mint sends nothing and leaves the draft ready to retry", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    conversationsPostMock = mock(
      async (..._args: unknown[]): Promise<MintedConversationResult> => {
        throw new Error("mint failed");
      },
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("");

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.status).toBe("error");
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe(
      "Couldn't send your message. Try again.",
    );
    // No row exists, so nothing goes out and nothing is recorded against an id
    // the daemon never minted.
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(documentsByIdConversationsPostMock).not.toHaveBeenCalled();
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBeNull();
    expect(useConversationStore.getState().processingConversationIds.size).toBe(
      0,
    );
    // The id stays marked as an unconfirmed client-side draft, and the text
    // the user typed is still in the composer.
    expect(useConversationStore.getState().draftConversationIds.size).toBe(1);
    expect(useComposerStore.getState().documentInput).toBe("hello");

    // The retry is an ordinary first send: the message the failed mint never
    // dispatched still carries its own idempotency nonce.
    conversationsPostMock = mock(defaultConversationsPost);
    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.status).toBe("sent");
    expect(postChatMessageMock).toHaveBeenCalledTimes(1);
    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe(MINTED_CONVERSATION_ID);
    expect(sentOptions(0).clientMessageId).toBeTruthy();
  });

  test("a refused document link on the mint path sends nothing, and the retry links the same row", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    documentsByIdConversationsPostMock.mockImplementationOnce(async () => {
      throw new Error("link refused");
    });
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("");

    await act(async () => {
      await result.current.submit();
    });

    // The assistant that minted the row has the link route, so a refusal is
    // the daemon saying no, not a route that isn't there: the first turn
    // would run without the document, so the message stays put.
    expect(result.current.status).toBe("error");
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe(
      "Couldn't send your message. Try again.",
    );
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(useComposerStore.getState().documentInput).toBe("hello");
    expect(useConversationStore.getState().processingConversationIds.size).toBe(
      0,
    );
    expect(isAwaitingReply(MINTED_CONVERSATION_ID)).toBe(false);

    await act(async () => {
      await result.current.submit();
    });

    // The row the mint already created is cached, so the retry reuses it
    // instead of minting a second one, and tries the link again.
    expect(conversationsPostMock).toHaveBeenCalledTimes(1);
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(2);
    expect(documentsByIdConversationsPostMock.mock.calls[1]?.[0]).toEqual({
      path: { assistant_id: ASSISTANT_ID, id: SURFACE_ID },
      body: { conversationId: MINTED_CONVERSATION_ID },
      throwOnError: true,
    });
    expect(result.current.status).toBe("sent");
    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe(MINTED_CONVERSATION_ID);
  });

  test("a retry that reuses the minted row still holds the send back until the link lands", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    documentsByIdConversationsPostMock.mockImplementationOnce(async () => {
      throw new Error("link refused");
    });
    documentsByIdConversationsPostMock.mockImplementationOnce(async () => {
      throw new Error("link refused again");
    });
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("");

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.status).toBe("error");
    expect(postChatMessageMock).not.toHaveBeenCalled();

    // The first attempt cached the minted id and dropped the draft mark, so
    // this one resolves a row it never minted: the link is required because
    // the assistant has the route, not because this attempt minted anything.
    await act(async () => {
      await result.current.submit();
    });

    expect(conversationsPostMock).toHaveBeenCalledTimes(1);
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(2);
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe("error");
    expect(toastErrorMock).toHaveBeenCalledTimes(2);
    expect(toastErrorMock.mock.calls[1]?.[0]).toBe(
      "Couldn't send your message. Try again.",
    );
    expect(useComposerStore.getState().documentInput).toBe("hello");
    expect(isAwaitingReply(MINTED_CONVERSATION_ID)).toBe(false);
    expect(useConversationStore.getState().processingConversationIds.size).toBe(
      0,
    );

    // The link finally lands, so the message goes out against the row the
    // first attempt minted.
    await act(async () => {
      await result.current.submit();
    });

    expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe("sent");
    expect(postChatMessageMock).toHaveBeenCalledTimes(1);
    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe(MINTED_CONVERSATION_ID);
  });

  test("a refused link on the mint path leaves the open document on the draft id, and the retry that links moves it", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    // The state `document-viewer-page`'s "Submit Feedback" leaves behind: the
    // document is open against a draft conversation, cached under the surface,
    // that nothing has sent against yet.
    useConversationStore.setState({
      draftConversationIds: new Set(["conv-draft"]),
    });
    setEditChatConversationId(ASSISTANT_ID, SURFACE_ID, "conv-draft");
    useViewerStore.setState({ openedDocumentState: OPENED_DRAFT_DOC });
    documentsByIdConversationsPostMock.mockImplementationOnce(async () => {
      throw new Error("link refused");
    });
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("");

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.status).toBe("error");
    expect(postChatMessageMock).not.toHaveBeenCalled();
    // The session cache says which row to reuse, so it takes the minted id.
    // The open document's conversation id says which row the document is
    // linked to, and that link was refused, so it stays on the draft.
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBe(
      MINTED_CONVERSATION_ID,
    );
    expect(openedConversationId()).toBe("conv-draft");

    await act(async () => {
      await result.current.submit();
    });

    // The retry reuses the row the mint created and asks for the link again
    // for real, rather than taking the shortcut an already-moved open document
    // would have handed it.
    expect(conversationsPostMock).toHaveBeenCalledTimes(1);
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(2);
    expect(documentsByIdConversationsPostMock.mock.calls[1]?.[0]).toEqual({
      path: { assistant_id: ASSISTANT_ID, id: SURFACE_ID },
      body: { conversationId: MINTED_CONVERSATION_ID },
      throwOnError: true,
    });
    expect(openedConversationId()).toBe(MINTED_CONVERSATION_ID);
    expect(result.current.status).toBe("sent");
    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe(MINTED_CONVERSATION_ID);
  });

  test("a refused link on the mint path keeps a document open against the draft off the dead id", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    // The overlay host, where the composer's `doc` is the open document
    // itself, so both are on the same draft conversation.
    useConversationStore.setState({
      draftConversationIds: new Set(["conv-draft"]),
    });
    setEditChatConversationId(ASSISTANT_ID, SURFACE_ID, "conv-draft");
    useViewerStore.setState({ openedDocumentState: OPENED_DRAFT_DOC });
    documentsByIdConversationsPostMock.mockImplementationOnce(async () => {
      throw new Error("link refused");
    });
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-draft");

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.status).toBe("error");
    expect(postChatMessageMock).not.toHaveBeenCalled();
    // The mint replaced the draft with a row under another id, and nothing is
    // linked to that row yet, so the draft mark stays: it is what makes the
    // retry resolve the minted row instead of the id the document is open
    // against.
    expect(
      useConversationStore.getState().draftConversationIds.has("conv-draft"),
    ).toBe(true);
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBe(
      MINTED_CONVERSATION_ID,
    );
    expect(openedConversationId()).toBe("conv-draft");

    await act(async () => {
      await result.current.submit();
    });

    // The retry reuses the minted row, links it for real, and moves the open
    // document onto it. The draft id the daemon never minted goes nowhere.
    expect(conversationsPostMock).toHaveBeenCalledTimes(1);
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(2);
    expect(documentsByIdConversationsPostMock.mock.calls[1]?.[0]).toEqual({
      path: { assistant_id: ASSISTANT_ID, id: SURFACE_ID },
      body: { conversationId: MINTED_CONVERSATION_ID },
      throwOnError: true,
    });
    expect(openedConversationId()).toBe(MINTED_CONVERSATION_ID);
    expect(result.current.status).toBe("sent");
    expect(postChatMessageMock).toHaveBeenCalledTimes(1);
    expect(postChatMessageMock.mock.calls[0]?.[1]).toBe(MINTED_CONVERSATION_ID);
  });

  test("a refused link on an assistant without server minting still sends", async () => {
    documentsByIdConversationsPostMock.mockImplementationOnce(async () => {
      throw new Error("no such route");
    });
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("");

    await act(async () => {
      await result.current.submit();
    });

    // The route may not exist at all on this assistant, so the link stays
    // best-effort: the message goes out rather than being held back forever.
    expect(postChatMessageMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("sent");
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe("queued sends", () => {
  test("a queued result clears the draft and still awaits the reply", async () => {
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => ({
        ok: true,
        queued: true,
        assistantId: ASSISTANT_ID,
        conversationId: "conv-existing",
        requestId: "req-1",
      }),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    // A queued message still gets its own turn, whose `message_complete` is
    // what the reply watcher waits for, so the surface behaves as it does for
    // an immediately-processed send.
    expect(useComposerStore.getState().documentInput).toBe("");
    expect(result.current.status).toBe("sent");
    expect(toastInfoMock).toHaveBeenCalledTimes(1);
    expect(isAwaitingReply("conv-existing")).toBe(true);
    // The POST response races the running turn's `generation_handoff`, so it
    // is not what flags the wait: the watcher does that off the ordered
    // `message_queued` stream event instead.
    expect(isQueuedReply("conv-existing")).toBe(false);
  });

  test("an immediately-accepted result leaves the wait unflagged", async () => {
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    expect(isAwaitingReply("conv-existing")).toBe(true);
    expect(isQueuedReply("conv-existing")).toBe(false);
  });
});

describe("when the reply wait goes up", () => {
  test("the wait is up before the send resolves", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // The daemon answers a deduplicated retry exactly as it answers a fresh
    // accept, so the wait cannot be raised off the response.
    expect(isAwaitingReply("conv-existing")).toBe(true);

    await act(async () => {
      settle(sentResult("conv-existing"));
      await submitted;
    });

    expect(isAwaitingReply("conv-existing")).toBe(true);
  });

  test("the wait carries the nonce the POST went out with", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // The watcher matches `message_queued` against this id, so the wait holds
    // the nonce the POST is carrying while that POST is still in flight.
    const sentNonce = sentOptions(0).clientMessageId as string;
    expect(sentNonce).toBeTruthy();
    expect(awaitingNonce("conv-existing")).toBe(sentNonce);

    await act(async () => {
      settle(sentResult("conv-existing"));
      await submitted;
    });

    expect(awaitingNonce("conv-existing")).toBe(sentNonce);
  });

  test("a wait moved onto the row the daemon answered with keeps the nonce", async () => {
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> =>
        sentResult("conv-minted"),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-key");

    await act(async () => {
      await result.current.submit();
    });

    // The legacy `conversationKey` path answers with the row the daemon
    // minted rather than the key that went out, and the message the watcher
    // is matching on is still the one this send carried.
    expect(isAwaitingReply("conv-key")).toBe(false);
    expect(isAwaitingReply("conv-minted")).toBe(true);
    expect(awaitingNonce("conv-minted")).toBe(
      sentOptions(0).clientMessageId as string,
    );
  });

  test("a retry the daemon dedupes never raises a second wait", async () => {
    let calls = 0;
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => {
        calls += 1;
        if (calls === 1) {
          throw new Error("network dropped");
        }
        return sentResult("conv-existing");
      },
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.status).toBe("error");

    // The first attempt landed after all and its turn finished, so the
    // watcher took the wait back down before the user retried.
    useDocumentComposerReplyStore.getState().settleOldestReply("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    // The daemon deduped the retry against a turn that is already over, and
    // nothing in its response says so. Nothing is left waiting, so the next
    // unrelated completion cannot fire an "Assistant replied" toast.
    expect(result.current.status).toBe("sent");
    expect(isAwaitingReply("conv-existing")).toBe(false);
  });

  test("a refused retry takes down the wait its first attempt raised", async () => {
    let calls = 0;
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => {
        calls += 1;
        if (calls === 1) {
          throw new Error("network dropped");
        }
        return { ok: false, status: 500, error: { detail: "boom" } };
      },
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    // GIVEN a first attempt that never reached the daemon, so the wait it
    // raised is still up when the user retries.
    await act(async () => {
      await result.current.submit();
    });
    expect(isAwaitingReply("conv-existing")).toBe(true);

    // WHEN the daemon answers the retry and refuses it.
    await act(async () => {
      await result.current.submit();
    });

    // THEN no reply is coming for this message under any attempt, so the
    // wait the first attempt raised comes down with the retry's mark.
    expect(result.current.status).toBe("error");
    expect(isAwaitingReply("conv-existing")).toBe(false);
    expect(isProcessing("conv-existing")).toBe(false);
  });

  test("a refused retry leaves another message's wait alone", async () => {
    let calls = 0;
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => {
        calls += 1;
        if (calls === 1) {
          throw new Error("network dropped");
        }
        return { ok: false, status: 500, error: { detail: "boom" } };
      },
    );
    // GIVEN an earlier message still awaiting its reply in this conversation.
    useDocumentComposerReplyStore
      .getState()
      .startAwaitingReply("conv-existing", "nonce-of-an-earlier-send");
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    // WHEN the daemon refuses the retry.
    await act(async () => {
      await result.current.submit();
    });

    // THEN the wait is the earlier message's, raised under its nonce, and is
    // not this one's to take down.
    expect(result.current.status).toBe("error");
    expect(isAwaitingReply("conv-existing")).toBe(true);
    expect(awaitingNonce("conv-existing")).toBe("nonce-of-an-earlier-send");
  });

  test("a second send to the same conversation lists itself too", async () => {
    // GIVEN a first send the daemon has taken, whose reply is still on its
    // way, so the composer is enabled again.
    useComposerStore.getState().setInput("one", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.status).toBe("sent");

    // WHEN a second message goes out to the same conversation.
    useComposerStore.getState().setInput("two", "document");
    await act(async () => {
      await result.current.submit();
    });

    // THEN both sends are listed, oldest first and each under its own nonce,
    // so the watcher can settle them one terminal at a time.
    const pending = useDocumentComposerReplyStore
      .getState()
      .pendingReplies.get("conv-existing");
    expect(pending?.map((p) => p.clientMessageId)).toEqual([
      sentOptions(0).clientMessageId as string,
      sentOptions(1).clientMessageId as string,
    ]);
  });

  test("a refused second send leaves the first one listed and processing", async () => {
    let calls = 0;
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => {
        calls += 1;
        if (calls === 1) {
          return sentResult("conv-existing");
        }
        return { ok: false, status: 500, error: { detail: "boom" } };
      },
    );

    // GIVEN a first send the daemon took, still awaiting its reply.
    useComposerStore.getState().setInput("one", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    // WHEN a second send to the same conversation is refused.
    useComposerStore.getState().setInput("two", "document");
    await act(async () => {
      await result.current.submit();
    });

    // THEN only the refused message comes off the list, and the mark stays up
    // for the turn the first send still has running.
    expect(result.current.status).toBe("error");
    const pending = useDocumentComposerReplyStore
      .getState()
      .pendingReplies.get("conv-existing");
    expect(pending?.map((p) => p.clientMessageId)).toEqual([
      sentOptions(0).clientMessageId as string,
    ]);
    expect(isProcessing("conv-existing")).toBe(true);
  });
});

describe("the sidebar processing mark", () => {
  test("the mark is up before the send resolves", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // The daemon can queue this message behind a running turn, run it and
    // finish it before the POST answers, and the watcher takes the mark down
    // with the wait it ends, so the mark has to be up by the time the message
    // goes out.
    expect(isProcessing("conv-existing")).toBe(true);

    await act(async () => {
      settle(sentResult("conv-existing"));
      await submitted;
    });

    expect(isProcessing("conv-existing")).toBe(true);
  });

  test("a send the daemon answered and refused takes the mark back down", async () => {
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => ({
        ok: false,
        status: 500,
        error: { detail: "boom" },
      }),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    // Nothing is persisted and no turn will run, so the sidebar has nothing
    // to show as processing.
    expect(isProcessing("conv-existing")).toBe(false);
  });

  test("a turn the watcher ended while the send was in flight stays ended", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // What the watcher does when the whole turn runs and completes before the
    // POST answers: it ends the wait and takes the mark down with it.
    useDocumentComposerReplyStore.getState().settleOldestReply("conv-existing");
    useConversationStore
      .getState()
      .removeProcessingConversationId("conv-existing");

    await act(async () => {
      settle(sentResult("conv-existing"));
      await submitted;
    });

    // The response says nothing about a turn that is already over, so it must
    // not put the conversation back on the sidebar as processing.
    expect(isProcessing("conv-existing")).toBe(false);
    expect(isAwaitingReply("conv-existing")).toBe(false);
  });

  test("a mark moved onto the row the daemon answered with keeps its snapshot", async () => {
    queryClient.setQueryData(
      conversationListQueryKey(ASSISTANT_ID),
      listPage([
        {
          conversationId: "conv-key",
          title: "t",
          createdAt: 1,
          lastMessageAt: 2,
          latestAssistantMessageAt: 555,
        },
      ]),
    );
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> =>
        sentResult("conv-minted"),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-key");

    await act(async () => {
      await result.current.submit();
    });

    // The legacy `conversationKey` path answers with the row the daemon
    // minted rather than the key that went out, and the mark follows the wait
    // onto it with the snapshot the graduation sweep compares against.
    expect(isProcessing("conv-key")).toBe(false);
    expect(isProcessing("conv-minted")).toBe(true);
    expect(
      useConversationStore.getState().processingSnapshots.get("conv-minted"),
    ).toBe(555);
  });
});

describe("idempotency nonce", () => {
  test("the POST carries a client message id", async () => {
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    expect(sentOptions(0).clientMessageId).toBeTruthy();
  });

  test("a retry after a thrown send reuses the same client message id", async () => {
    let calls = 0;
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => {
        calls += 1;
        if (calls === 1) {
          throw new Error("network dropped");
        }
        return sentResult("conv-existing");
      },
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.status).toBe("error");

    // The failure leaves the draft in place, so this is the same message
    // going out again and the daemon dedupes it against the first attempt if
    // that one landed and only its response was lost.
    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.status).toBe("sent");
    expect(sentOptions(1).clientMessageId).toBe(
      sentOptions(0).clientMessageId as string,
    );
  });

  test("a retry after a thrown send mints a fresh id when the draft changed", async () => {
    let calls = 0;
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => {
        calls += 1;
        if (calls === 1) {
          throw new Error("network dropped");
        }
        return sentResult("conv-existing");
      },
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.status).toBe("error");

    // The user edits the draft before retrying. Reusing the prior nonce would
    // have the daemon dedupe the retry back to the ORIGINAL payload and this
    // send resolve as the old message, silently discarding the edit, so the
    // retry must mint a fresh id that the daemon treats as a new message.
    useComposerStore.getState().setInput("hello, edited", "document");
    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.status).toBe("sent");
    expect(sentOptions(1).clientMessageId).toBeTruthy();
    expect(sentOptions(1).clientMessageId).not.toBe(
      sentOptions(0).clientMessageId as string,
    );
  });

  test("a send the daemon answered and refused starts the next attempt fresh", async () => {
    let calls = 0;
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => {
        calls += 1;
        if (calls === 1) {
          return { ok: false, status: 500, error: { detail: "boom" } };
        }
        return sentResult("conv-existing");
      },
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.status).toBe("error");
    // The daemon answered, so nothing was persisted and nothing owes a reply.
    expect(isAwaitingReply("conv-existing")).toBe(false);

    await act(async () => {
      await result.current.submit();
    });

    // There is nothing for the daemon to dedupe this against, so it goes out
    // as an ordinary first send: its own nonce, and its own wait.
    expect(result.current.status).toBe("sent");
    expect(sentOptions(1).clientMessageId).toBeTruthy();
    expect(sentOptions(1).clientMessageId).not.toBe(
      sentOptions(0).clientMessageId as string,
    );
    expect(isAwaitingReply("conv-existing")).toBe(true);
  });

  test("a send after a success gets a fresh client message id", async () => {
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    useComposerStore.getState().setInput("second message", "document");
    await act(async () => {
      await result.current.submit();
    });

    expect(sentOptions(1).clientMessageId).toBeTruthy();
    expect(sentOptions(1).clientMessageId).not.toBe(
      sentOptions(0).clientMessageId as string,
    );
  });
});

describe("a send that outlives its owner", () => {
  test("a completion after the hook moved to another document leaves the new draft alone", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "conv-a",
    });

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // The standalone `/documents/:surfaceId` route keeps one hook instance
    // across documents, so the send resolves into a live hook pointed at a
    // different surface.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });
    useComposerStore.getState().setInput("about the second doc", "document");

    await act(async () => {
      settle(sentResult("conv-a"));
      await submitted;
    });

    expect(useComposerStore.getState().documentInput).toBe(
      "about the second doc",
    );
    // "Sent" belongs to the composer the send left, so the one on screen goes
    // back to idle rather than reporting a send it never made.
    expect(result.current.status).toBe("idle");
    // The rest of the success path is unconditional: the sent conversation is
    // still handed to the reply watcher.
    expect(isAwaitingReply("conv-a")).toBe(true);
  });

  test("a completion after the hook moved on leaves the new document's send in flight", async () => {
    const settleFirst = deferPostChatMessage();
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "conv-a",
    });

    let submittedFirst: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedFirst = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });
    useComposerStore.getState().setInput("about the second doc", "document");
    // The second document's own send, left in flight under a mock of its own
    // while the first one is still out.
    const settleSecond = deferPostChatMessage();
    let submittedSecond: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedSecond = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe("sending");

    await act(async () => {
      settleFirst(sentResult("conv-a"));
      await submittedFirst;
    });

    // The first document's send is over on a composer that has moved on, so
    // it says nothing about the status: reporting idle here would re-enable
    // the send button while the second document's POST is still out, and let
    // the unchanged draft go out a second time.
    expect(result.current.status).toBe("sending");

    await act(async () => {
      settleSecond(sentResult("conv-b"));
      await submittedSecond;
    });
    expect(result.current.status).toBe("sent");
  });

  test("a completion after the assistant changed under the document leaves the new draft alone", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID);

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // Switching assistants with the document still open clears the draft and
    // hands the shared slot to the incoming assistant's composer, so the
    // surface id alone no longer identifies who the send belongs to.
    rerender({ assistantId: "assistant-2" });
    useComposerStore
      .getState()
      .setInput("for the second assistant", "document");

    await act(async () => {
      settle(sentResult("conv-a"));
      await submitted;
    });

    expect(useComposerStore.getState().documentInput).toBe(
      "for the second assistant",
    );
    expect(result.current.status).toBe("idle");
    // The message did land, so the confirmation toast still fires, and the
    // wait raised before the POST went up while this assistant was still the
    // active one.
    expect(toastInfoMock).toHaveBeenCalledTimes(1);
    expect(isAwaitingReply("conv-a")).toBe(true);
  });

  test("a completion after the assistant left and came back leaves the new draft alone", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("for the first draft", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID);

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // Away and back: the assistant matches the one this send started under
    // again, but the round trip cleared the draft twice and the composer on
    // screen belongs to the draft typed after it.
    rerender({ assistantId: "assistant-2" });
    rerender({ assistantId: ASSISTANT_ID });
    useComposerStore.getState().setInput("a draft typed since", "document");

    await act(async () => {
      settle(sentResult("conv-a"));
      await submitted;
    });

    expect(useComposerStore.getState().documentInput).toBe(
      "a draft typed since",
    );
    expect(result.current.status).toBe("idle");
  });

  test("a completion after the hook unmounted leaves the new draft alone", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, unmount } = renderSubmit("conv-a");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // `MobileDocumentOverlay` keys the panel per surface, so switching
    // documents unmounts this instance while its send is still in flight.
    unmount();
    useComposerStore.getState().setInput("about the second doc", "document");

    await act(async () => {
      settle(sentResult("conv-a"));
      await submitted;
    });

    expect(useComposerStore.getState().documentInput).toBe(
      "about the second doc",
    );
    expect(isAwaitingReply("conv-a")).toBe(true);
  });

  test("an assistant switch while the conversation is being minted drops the send", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    const settleMint = deferConversationsPost();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID, "");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(conversationsPostMock).toHaveBeenCalledTimes(1));

    rerender({ assistantId: "assistant-2" });
    useComposerStore
      .getState()
      .setInput("for the second assistant", "document");

    await act(async () => {
      settleMint();
      await submitted;
    });

    // `postChatMessage` picks its wire field from whichever assistant is
    // active when it runs, so a send framed for the outgoing one stops here
    // rather than going out under the incoming one's version.
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(documentsByIdConversationsPostMock).not.toHaveBeenCalled();
    // Nothing went out, so there is nothing to report and nothing to wait on.
    expect(toastInfoMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(useDocumentComposerReplyStore.getState().pendingReplies.size).toBe(
      0,
    );
    expect(useConversationStore.getState().processingConversationIds.size).toBe(
      0,
    );
    // The incoming assistant's composer is untouched and still sendable.
    expect(useComposerStore.getState().documentInput).toBe(
      "for the second assistant",
    );
    expect(result.current.status).toBe("idle");
  });

  test("an assistant switch while the document is being linked drops the send, and the next one is ordinary", async () => {
    const settleLink = deferDocumentLink();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID, "");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() =>
      expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(1),
    );

    rerender({ assistantId: "assistant-2" });

    await act(async () => {
      settleLink();
      await submitted;
    });

    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(toastInfoMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");

    // The dropped attempt left no nonce behind: the incoming assistant's own
    // message is a first send, with its own id and its own wait.
    useAssistantIdentityStore.setState({
      version: "0.8.5",
      assistantId: "assistant-2",
    });
    useComposerStore
      .getState()
      .setInput("for the second assistant", "document");
    await act(async () => {
      await result.current.submit();
    });

    expect(postChatMessageMock).toHaveBeenCalledTimes(1);
    expect(sentOptions(0).clientMessageId).toBeTruthy();
    expect(result.current.status).toBe("sent");
    expect(
      isAwaitingReply(postChatMessageMock.mock.calls[0]?.[1] as string),
    ).toBe(true);
  });

  test("an assistant switch while the document is being linked leaves the incoming assistant's document alone", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    useConversationStore.setState({
      draftConversationIds: new Set(["conv-draft"]),
    });
    useViewerStore.setState({ openedDocumentState: OPENED_DRAFT_DOC });
    const settleLink = deferDocumentLink();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(
      ASSISTANT_ID,
      "conv-draft",
    );

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() =>
      expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(1),
    );

    // The user switches assistants and reopens the same document, which is
    // the incoming assistant's from here.
    rerender({ assistantId: "assistant-2" });

    await act(async () => {
      settleLink();
      await submitted;
    });

    // The link landed, for the assistant the user left. Both writes it leads
    // to are keyed by surface id alone, so running them now would point the
    // document the incoming assistant has open at the outgoing one's row and
    // hand that row to its next send.
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(openedConversationId()).toBe("conv-draft");
    expect(getEditChatConversationId("assistant-2", SURFACE_ID)).toBeNull();
  });

  test("a document switch while the document is being linked still sends", async () => {
    const settleLink = deferDocumentLink();
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "",
    });

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() =>
      expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(1),
    );

    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });
    useComposerStore.getState().setInput("about the second doc", "document");

    await act(async () => {
      settleLink();
      await submitted;
    });

    // The send still belongs to the first document's conversation, and the
    // version gates that frame it never moved, so only the composer's own
    // state is off limits.
    const sentConversationId = postChatMessageMock.mock.calls[0]?.[1] as string;
    expect(sentConversationId).toBeTruthy();
    expect(useComposerStore.getState().documentInput).toBe(
      "about the second doc",
    );
    expect(result.current.status).toBe("idle");
    expect(isAwaitingReply(sentConversationId)).toBe(true);
  });

  test("a send that lands after an assistant switch moves neither the wait nor the mark onto the answered row", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID);

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    rerender({ assistantId: "assistant-2" });

    await act(async () => {
      // The daemon answers with the row it minted rather than the key that
      // went out, which is what the success path would move the wait onto.
      settle(sentResult("conv-minted"));
      await submitted;
    });

    // Both went up before the POST, under the id the send went out on, and
    // neither moves onto the row the daemon answered with: that row's turn
    // runs on an SSE connection the client has left, where nothing but an
    // unrelated completion could ever take them down.
    expect(isAwaitingReply("conv-minted")).toBe(false);
    expect(isProcessing("conv-minted")).toBe(false);
  });

  test("a refused send after an assistant switch reports the error without disabling the new composer", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID);

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    rerender({ assistantId: "assistant-2" });
    useComposerStore
      .getState()
      .setInput("for the second assistant", "document");

    await act(async () => {
      settle({ ok: false, status: 500, error: { detail: "boom" } });
      await submitted;
    });

    // "Error" is the outgoing composer's micro-state: leaving it on the
    // incoming one would disable a composer that never sent anything.
    expect(result.current.status).toBe("idle");
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe("boom");
    expect(useComposerStore.getState().documentInput).toBe(
      "for the second assistant",
    );
  });

  test("a thrown send after an assistant switch reports the error without disabling the new composer", async () => {
    const fail = failPostChatMessage();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID);

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    rerender({ assistantId: "assistant-2" });

    await act(async () => {
      fail();
      await submitted;
    });

    expect(result.current.status).toBe("idle");
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe(
      "Couldn't send your message. Try again.",
    );
  });

  test("a completion after the hook moved on leaves the newer attempt's nonce alone", async () => {
    // GIVEN a send for the first document still in flight.
    const settleFirst = deferPostChatMessage();
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "conv-a",
    });

    let submittedFirst: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedFirst = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // WHEN the hook moves to a second document whose own send fails
    // ambiguously, so its nonce is the one a retry has to carry.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });
    useComposerStore.getState().setInput("about the second doc", "document");
    const failSecond = failPostChatMessage();
    let submittedSecond: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedSecond = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));
    const secondNonce = sentOptions(0).clientMessageId as string;
    expect(secondNonce).toBeTruthy();
    await act(async () => {
      failSecond();
      await submittedSecond;
    });

    // ... and the first document's send lands afterwards.
    await act(async () => {
      settleFirst(sentResult("conv-a"));
      await submittedFirst;
    });

    // THEN the second document's retry still carries its own nonce, so a first
    // attempt the daemon accepted and only failed to answer is deduped.
    postChatMessageMock = mock(defaultPostChatMessage);
    await act(async () => {
      await result.current.submit();
    });

    expect(sentOptions(0).clientMessageId).toBe(secondNonce);
  });

  test("a refused send after the hook moved on leaves the newer attempt's nonce alone", async () => {
    // GIVEN a send for the first document still in flight.
    const settleFirst = deferPostChatMessage();
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "conv-a",
    });

    let submittedFirst: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedFirst = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // WHEN the hook moves to a second document whose own send fails
    // ambiguously, and the first document's send comes back refused.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });
    useComposerStore.getState().setInput("about the second doc", "document");
    const failSecond = failPostChatMessage();
    let submittedSecond: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedSecond = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));
    const secondNonce = sentOptions(0).clientMessageId as string;
    await act(async () => {
      failSecond();
      await submittedSecond;
    });
    await act(async () => {
      settleFirst({ ok: false, status: 500, error: { detail: "boom" } });
      await submittedFirst;
    });

    // THEN the retry for the second document still carries its own nonce.
    postChatMessageMock = mock(defaultPostChatMessage);
    await act(async () => {
      await result.current.submit();
    });

    expect(sentOptions(0).clientMessageId).toBe(secondNonce);
  });

  test("a refused send after the hook moved on ends only the wait it raised", async () => {
    // GIVEN a send for the first document in flight, with its wait up.
    const settleFirst = deferPostChatMessage();
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "conv-a",
    });

    let submittedFirst: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedFirst = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));
    expect(isAwaitingReply("conv-a")).toBe(true);

    // WHEN the hook moves to a second document that raises a wait of its own.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });
    useComposerStore.getState().setInput("about the second doc", "document");
    const settleSecond = deferPostChatMessage();
    let submittedSecond: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedSecond = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));
    expect(isAwaitingReply("conv-b")).toBe(true);

    // ... and the first document's send comes back refused.
    await act(async () => {
      settleFirst({ ok: false, status: 500, error: { detail: "boom" } });
      await submittedFirst;
    });

    // THEN only the refused message's own wait ends: it can never be replied
    // to, and the second document is still waiting on the send it has out.
    expect(isAwaitingReply("conv-a")).toBe(false);
    expect(isAwaitingReply("conv-b")).toBe(true);

    await act(async () => {
      settleSecond(sentResult("conv-b"));
      await submittedSecond;
    });
    expect(isAwaitingReply("conv-b")).toBe(true);
  });

  test("a send that lands after the hook moved on moves only its own wait", async () => {
    // GIVEN a send for the first document in flight, with its wait up.
    const settleFirst = deferPostChatMessage();
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "conv-a",
    });

    let submittedFirst: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedFirst = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // WHEN the hook moves to a second document that raises a wait of its own.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });
    useComposerStore.getState().setInput("about the second doc", "document");
    const settleSecond = deferPostChatMessage();
    let submittedSecond: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedSecond = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));
    expect(isAwaitingReply("conv-b")).toBe(true);

    // ... and the first document's send answers with a row of its own.
    await act(async () => {
      settleFirst(sentResult("conv-a-real"));
      await submittedFirst;
    });

    // THEN the wait that moves is the one the first send raised, and the
    // second document keeps the wait it is still holding.
    expect(isAwaitingReply("conv-a")).toBe(false);
    expect(isAwaitingReply("conv-a-real")).toBe(true);
    expect(isAwaitingReply("conv-b")).toBe(true);

    await act(async () => {
      settleSecond(sentResult("conv-b"));
      await submittedSecond;
    });
  });
});
