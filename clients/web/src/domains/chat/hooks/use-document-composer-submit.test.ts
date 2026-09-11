/**
 * Tests for `useDocumentComposerSubmit`, the pinned document composer's
 * submit logic. Covers the conversation-id resolution branches (existing /
 * cached / fresh-mint, with and without server-side minting), the snapshot
 * passed to the sidebar's processing tracking, the success and failure
 * paths, the empty-content/uploading guards, and the hand-off of the
 * conversation to watch for a reply to `document-composer-reply-store`.
 * Also covers the queued-send result, the queue mark the response stands in
 * for while the stream has not spoken for the send, the stream echo that
 * marks a send the response accepted running, the idempotency nonce
 * carried on the POST, when the wait for a reply is raised and taken back
 * down, and the guard that keeps a late-resolving send from clearing a draft
 * typed for a document, or an assistant, it was never about. Also covers
 * dropping a send whose assistant changed while it was resolving, and the
 * refused document link that stops the first turn from running without the
 * document. Ownership covers the round trip too (away to another assistant
 * and back), alongside the full slot reset that frees the composer's preview
 * URLs and the "View conversation" action going quiet under another
 * assistant. The version the send is framed against is covered as well: the
 * wait for an identity that has not hydrated, and a version that flips
 * mid-flight failing the send rather than posting under a frame the row was
 * never minted for. The staged image is checked again at submit against the
 * model of the conversation it goes to, and the retry handle a send that
 * outlived its owner leaves to the composer on screen.
 *
 * The "Assistant replied" toast that hand-off leads to belongs to
 * `DocumentComposerReplyWatcher` and is covered by its own test file.
 *
 * `postChatMessage`, `conversationsPost` and `documentsByIdConversationsPost`
 * are mocked (network); `edit-chat-session` (sessionStorage) and the
 * composer/conversation/reply stores are real, so the resolution branches are
 * exercised for real rather than asserted against a mock's call args.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import type { PostMessageResult } from "@/domains/chat/api/messages";
import type { ComposerSlot } from "@/domains/chat/composer-store";
import type { DocumentConversationRef } from "@/domains/chat/utils/document-conversation";
import chatEn from "@/i18n/locales/en/chat.json";

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
const {
  getEditChatConversationId,
  getEditChatDraftReplacement,
  setEditChatConversationId,
} = await import("@/utils/edit-chat-session");
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
const UPLOADED_ATTACHMENT = {
  kind: "uploaded" as const,
  localId: "local-1",
  id: "srv-1",
  filename: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  previewUrl: null,
};

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

function renderSubmit(
  conversationId: string,
  imageAttachmentsAllowed: boolean | null = true,
) {
  return renderHook(
    () =>
      useDocumentComposerSubmit({
        assistantId: ASSISTANT_ID,
        doc: { surfaceId: SURFACE_ID, conversationId },
        imageAttachmentsAllowed,
      }),
    { wrapper },
  );
}

/** Renders against a swappable `doc`, for the mid-flight document switch. */
function renderSubmitFor(doc: DocumentConversationRef) {
  return renderHook(
    ({ doc: current }: { doc: DocumentConversationRef }) =>
      useDocumentComposerSubmit({
        assistantId: ASSISTANT_ID,
        doc: current,
        imageAttachmentsAllowed: true,
      }),
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
        imageAttachmentsAllowed: true,
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

/** Throws the first POST, and answers `conversationId` for the ones after. */
function throwFirstPostChatMessage(conversationId: string): void {
  let calls = 0;
  postChatMessageMock = mock(
    async (..._args: unknown[]): Promise<PostMessageResult> => {
      calls += 1;
      if (calls === 1) {
        throw new Error("network dropped");
      }
      return sentResult(conversationId);
    },
  );
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
function deferDocumentLink(success = true): () => void {
  let settle: () => void = () => {};
  const pending = new Promise<{ data: { success: boolean } }>(
    (resolve, reject) => {
      settle = () => {
        if (success) {
          resolve({ data: { success: true } });
        } else {
          reject(new Error("link failed"));
        }
      };
    },
  );
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

/** Every send still awaiting a reply in `conversationId`, oldest first. */
function awaitingSends(conversationId: string) {
  return (
    useDocumentComposerReplyStore
      .getState()
      .pendingReplies.get(conversationId) ?? []
  );
}

/** The nonce of the oldest send still awaiting a reply in `conversationId`. */
function awaitingNonce(conversationId: string): string | undefined {
  return useDocumentComposerReplyStore
    .getState()
    .pendingReplies.get(conversationId)?.[0]?.clientMessageId;
}

/**
 * The message the oldest send still awaiting a reply in `conversationId`
 * carried, kept for a failure the daemon reports after the composer has been
 * cleared. `undefined` when nothing is awaiting a reply there.
 */
function awaitingPayload(conversationId: string) {
  return useDocumentComposerReplyStore
    .getState()
    .pendingReplies.get(conversationId)?.[0]?.payload;
}

/**
 * The message held for `surfaceId` under `assistantId`, taken the way that
 * document's composer panel takes it when the document opens again under that
 * assistant. Null when none is held.
 */
function takeHeldMessage(surfaceId: string, assistantId = ASSISTANT_ID) {
  return useDocumentComposerReplyStore
    .getState()
    .takeFailedSend(assistantId, surfaceId);
}

/** The messages an assistant switch detached from sends, by nonce. */
function detachedSends() {
  return useDocumentComposerReplyStore.getState().detachedSends;
}

/** Queued messages kept while their assistant's stream is detached. */
function detachedQueuedSends() {
  return useDocumentComposerReplyStore.getState().detachedQueuedSends;
}

/**
 * What an assistant switch does to the stores before the host renders the
 * incoming assistant: every wait the outgoing assistant's sends raised is
 * dropped, and another assistant is active.
 */
function switchAssistantAway(): void {
  useDocumentComposerReplyStore.getState().clearAwaitingReplies();
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
}

/**
 * How the oldest send still awaiting a reply in `conversationId` stands:
 * whether the daemon has taken it in, and whether it is queued rather than
 * running. `undefined` when nothing is awaiting a reply there.
 */
function awaitingState(
  conversationId: string,
): { acknowledged: boolean; queued: boolean } | undefined {
  const pending = useDocumentComposerReplyStore
    .getState()
    .pendingReplies.get(conversationId)?.[0];
  return pending
    ? { acknowledged: pending.acknowledged, queued: pending.queued }
    : undefined;
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
  useDocumentComposerReplyStore.setState({
    pendingReplies: new Map(),
    failedSends: new Map(),
    claimedFailedSendBatches: new Map(),
    activeDocumentComposer: null,
    detachedSends: new Map(),
    detachedQueuedSends: new Map(),
  });
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
  useDocumentComposerReplyStore.setState({
    pendingReplies: new Map(),
    failedSends: new Map(),
    claimedFailedSendBatches: new Map(),
    activeDocumentComposer: null,
    detachedSends: new Map(),
    detachedQueuedSends: new Map(),
  });
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
      useConversationStore
        .getState()
        .draftConversationIds.has(sentConversationId),
    ).toBe(false);
  });

  test("a fresh draft on a server-mint-capable assistant mints and links the conversation before it sends", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    // The session cache is written for real (sessionStorage), so its ordering
    // against the send shows up here rather than in `callOrder`.
    const cachedIdAtSend: (string | null)[] = [];
    // The draft id this send resolves is minted inside the hook and its mark
    // is off before the send, so it is read while the mint is in flight.
    const draftIdsAtMint: string[] = [];
    const mintConversation = conversationsPostMock;
    conversationsPostMock = mock(async (...args: unknown[]) => {
      draftIdsAtMint.push(
        ...useConversationStore.getState().draftConversationIds,
      );
      return mintConversation(...(args as []));
    });
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
    // The draft the mint replaced maps to the minted row, so a surface still
    // holding that id resolves to the row instead of the dead draft.
    const draftId = draftIdsAtMint[0] ?? "";
    expect(draftId).not.toBe("");
    expect(getEditChatDraftReplacement(draftId)).toBe(MINTED_CONVERSATION_ID);
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
  test("a timed-out identity wait never sends under another assistant's version", async () => {
    jest.useFakeTimers();
    try {
      useAssistantIdentityStore.setState({
        version: "0.9.0",
        assistantId: "assistant-2",
      });
      useComposerStore.getState().setInput("hello", "document");
      const { result } = renderSubmit("conv-existing");

      let submitted: Promise<void> = Promise.resolve();
      await act(async () => {
        submitted = result.current.submit();
      });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
        await submitted;
      });

      expect(postChatMessageMock).not.toHaveBeenCalled();
      expect(result.current.status).toBe("error");
      expect(useComposerStore.getState().documentInput).toBe("hello");
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("closing the document during version resolution holds its full payload", async () => {
    useAssistantIdentityStore.setState({ version: null, assistantId: null });
    useComposerStore.setState({
      documentInput: "waiting for identity",
      documentAttachments: [UPLOADED_ATTACHMENT],
    });
    const { result, unmount } = renderSubmit("");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    unmount();
    act(() => {
      useAssistantIdentityStore.setState({
        version: "0.9.0",
        assistantId: ASSISTANT_ID,
      });
    });
    await act(async () => {
      await submitted;
    });

    expect(conversationsPostMock).not.toHaveBeenCalled();
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(takeHeldMessage(SURFACE_ID)).toEqual({
      assistantId: ASSISTANT_ID,
      surfaceId: SURFACE_ID,
      content: "waiting for identity",
      attachments: [UPLOADED_ATTACHMENT],
    });
  });

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
      () =>
        useDocumentComposerSubmit({
          assistantId: null,
          doc: null,
          imageAttachmentsAllowed: true,
        }),
      { wrapper },
    );
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });

    expect(postChatMessageMock).not.toHaveBeenCalled();
  });
});

describe("images against the target model", () => {
  /** Stages one uploaded attachment in the document slot, with a draft. */
  function stageDocumentAttachment(filename: string, mimeType: string): void {
    useComposerStore.setState({
      documentInput: "have a look",
      documentAttachments: [
        {
          kind: "uploaded",
          localId: "a1",
          id: "srv-1",
          filename,
          mimeType,
          sizeBytes: 1,
          previewUrl: null,
        },
      ],
    });
  }

  test("an image bound for a model without vision sends nothing", async () => {
    // GIVEN an image staged for a conversation whose model cannot see one.
    stageDocumentAttachment("photo.png", "image/png");
    const { result } = renderSubmit("conv-existing", false);

    // WHEN the composer submits.
    await act(async () => {
      await result.current.submit();
    });

    // THEN nothing goes out, the draft and the image are still there to edit,
    // and the slot says why: the model is what the send would have failed on.
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(useComposerStore.getState().documentInput).toBe("have a look");
    expect(useComposerStore.getState().documentAttachments).toHaveLength(1);
    expect(useComposerStore.getState().documentAttachmentLastError).toBe(
      chatEn.composerAttachments.imageNotSupported,
    );
    expect(result.current.status).toBe("idle");
  });

  test("an image sent before the gate resolves waits rather than failing the turn", async () => {
    // GIVEN an image staged while the target conversation's profile has not
    // resolved, so whether the model can see it is still unknown.
    stageDocumentAttachment("photo.png", "image/png");
    const { result } = renderSubmit("conv-existing", null);

    // WHEN the composer submits.
    await act(async () => {
      await result.current.submit();
    });

    // THEN nothing goes out, and the notice asks for another try instead of
    // naming a model the gate has not read yet.
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(useComposerStore.getState().documentAttachments).toHaveLength(1);
    expect(useComposerStore.getState().documentAttachmentLastError).toBe(
      chatEn.composerAttachments.imageGateResolving,
    );
  });

  test("an image bound for a vision-capable model goes out", async () => {
    // GIVEN an image staged for a conversation whose model can see one.
    stageDocumentAttachment("photo.png", "image/png");
    const { result } = renderSubmit("conv-existing", true);

    // WHEN the composer submits.
    await act(async () => {
      await result.current.submit();
    });

    // THEN the send carries the image and the slot raises no notice.
    expect(postChatMessageMock).toHaveBeenCalledTimes(1);
    expect(postChatMessageMock.mock.calls[0]?.[3]).toMatchObject({
      attachmentIds: ["srv-1"],
    });
    expect(useComposerStore.getState().documentAttachmentLastError).toBeNull();
  });

  test("a file that is not an image goes out on a model without vision", async () => {
    // GIVEN a text file staged for a conversation whose model has no vision.
    stageDocumentAttachment("notes.txt", "text/plain");
    const { result } = renderSubmit("conv-existing", false);

    // WHEN the composer submits.
    await act(async () => {
      await result.current.submit();
    });

    // THEN the gate has nothing to say about it and the send goes out.
    expect(postChatMessageMock).toHaveBeenCalledTimes(1);
    expect(useComposerStore.getState().documentAttachmentLastError).toBeNull();
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
    // The daemon answered that it parked the message and nothing on the
    // stream has spoken for the send yet, so the response is what flags it.
    expect(isQueuedReply("conv-existing")).toBe(true);
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

  test("the entry carries the message the send went out with", async () => {
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
        {
          kind: "failed",
          localId: "a2",
          filename: "g.txt",
          mimeType: "text/plain",
          sizeBytes: 2,
          error: "the upload failed",
        },
      ],
    });
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    // The daemon can report the send failed once this success path has
    // cleared the composer, so the entry holds what went out: the draft, and
    // the attachments that reached the server.
    const payload = awaitingPayload("conv-existing");
    // The assistant and the surface say whose composer wrote it, so a failure
    // the daemon reports later goes back to that document under that
    // assistant and no other.
    expect(payload?.assistantId).toBe(ASSISTANT_ID);
    expect(payload?.surfaceId).toBe(SURFACE_ID);
    expect(payload?.content).toBe("hello");
    expect(payload?.attachments).toHaveLength(1);
    expect(payload?.attachments[0]).toMatchObject({
      id: "srv-1",
      filename: "f.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      previewUrl: null,
    });
  });

  test("a wait moved onto the row the daemon answered with keeps the message", async () => {
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> =>
        sentResult("conv-minted"),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-key");

    await act(async () => {
      await result.current.submit();
    });

    // The legacy `conversationKey` path relists the send under the row the
    // daemon answered with, and the message it carried moves with it.
    expect(awaitingPayload("conv-key")).toBeUndefined();
    expect(awaitingPayload("conv-minted")).toEqual({
      assistantId: ASSISTANT_ID,
      surfaceId: SURFACE_ID,
      content: "hello",
      attachments: [],
    });
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

  test("a legacy daemon answering the key with its own row records the replacement", async () => {
    useConversationStore.getState().registerDraftConversationId("conv-key");
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> =>
        sentResult("conv-minted"),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-key");

    await act(async () => {
      await result.current.submit();
    });

    // The key went out as a client draft and the daemon materialized a row
    // under another id, so the key is retired and any surface still holding
    // it resolves to that row.
    expect(getEditChatDraftReplacement("conv-key")).toBe("conv-minted");
    expect(
      useConversationStore.getState().draftConversationIds.has("conv-key"),
    ).toBe(false);
  });

  test("a legacy daemon keeping the key records no replacement", async () => {
    useConversationStore.getState().registerDraftConversationId("conv-key");
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> =>
        sentResult("conv-key"),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-key");

    await act(async () => {
      await result.current.submit();
    });

    expect(getEditChatDraftReplacement("conv-key")).toBeNull();
    expect(
      useConversationStore.getState().draftConversationIds.has("conv-key"),
    ).toBe(false);
  });

  test("a response naming another row lists nothing once the watcher settled the send", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-key");
    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    const nonce = sentOptions(0).clientMessageId as string;
    expect(isAwaitingReply("conv-key")).toBe(true);

    // GIVEN the stream named the nonce under the row the daemon minted, so the
    // watcher moved the send there, and the turn then finished before the
    // POST answered.
    useDocumentComposerReplyStore
      .getState()
      .stopAwaitingReply("conv-key", nonce);
    useConversationStore.getState().removeProcessingConversationId("conv-key");

    // WHEN the response names that row.
    await act(async () => {
      settle(sentResult("conv-minted"));
      await submitted;
    });

    // THEN nothing is listed for a turn that is over, under either id, and no
    // mark comes back up for it.
    expect(result.current.status).toBe("sent");
    expect(isAwaitingReply("conv-key")).toBe(false);
    expect(isAwaitingReply("conv-minted")).toBe(false);
    expect(isProcessing("conv-minted")).toBe(false);
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

    // The first attempt landed after all: the daemon echoed the send back on
    // the stream, and the terminal that followed settled it, so the watcher
    // took the wait and the processing mark back down before the user
    // retried.
    useDocumentComposerReplyStore
      .getState()
      .markReplyRunning("conv-existing", sentOptions(0).clientMessageId);
    useDocumentComposerReplyStore
      .getState()
      .settleRunningReplies("conv-existing");
    useConversationStore
      .getState()
      .removeProcessingConversationId("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    // The daemon deduped the retry against a turn that is already over, and
    // nothing in its response says so. Nothing is left waiting, so the next
    // unrelated completion cannot fire an "Assistant replied" toast, and no
    // mark goes back up for a turn nothing will end again.
    expect(result.current.status).toBe("sent");
    expect(isAwaitingReply("conv-existing")).toBe(false);
    expect(isProcessing("conv-existing")).toBe(false);
  });

  test("a retry of a message still pending keeps its processing mark up", async () => {
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

    // GIVEN a first attempt that threw while its entry is still pending.
    await act(async () => {
      await result.current.submit();
    });
    expect(isAwaitingReply("conv-existing")).toBe(true);

    // WHEN the user retries the same draft.
    await act(async () => {
      await result.current.submit();
    });

    // THEN the entry it rides carries the mark, so the mark is up for the
    // watcher to take down with it.
    expect(result.current.status).toBe("sent");
    expect(isAwaitingReply("conv-existing")).toBe(true);
    expect(isProcessing("conv-existing")).toBe(true);
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

describe("acknowledging the send", () => {
  test("a response that took the message for a turn leaves it unacknowledged", async () => {
    // GIVEN a send whose POST is still in flight.
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // THEN nothing speaks for it yet, so a terminal that arrives in this
    // window belongs to some other turn and cannot settle it.
    expect(awaitingState("conv-existing")).toEqual({
      acknowledged: false,
      queued: false,
    });

    // WHEN the daemon answers that it took the message for a turn.
    await act(async () => {
      settle(sentResult("conv-existing"));
      await submitted;
    });

    // THEN the send is still unacknowledged: the response is not ordered
    // against the stream, so a terminal in flight from the turn before would
    // settle a send it had marked running.
    expect(awaitingState("conv-existing")).toEqual({
      acknowledged: false,
      queued: false,
    });
  });

  test("the stream's echo is what marks a send the response accepted running", async () => {
    // GIVEN a send the daemon answered as taken for a turn.
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });
    expect(awaitingState("conv-existing")).toEqual({
      acknowledged: false,
      queued: false,
    });

    // WHEN the daemon's echo for that nonce arrives on the stream.
    act(() => {
      useDocumentComposerReplyStore
        .getState()
        .markReplyRunning("conv-existing", sentOptions(0).clientMessageId);
    });

    // THEN the send is running, and the next terminal there is its own.
    expect(awaitingState("conv-existing")).toEqual({
      acknowledged: true,
      queued: false,
    });
  });

  test("a terminal before the echo settles nothing the response accepted", async () => {
    // GIVEN a send the daemon answered as taken for a turn, whose echo the
    // stream has not delivered yet.
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    // WHEN the turn before this send emits its terminal.
    let settled = 0;
    act(() => {
      settled = useDocumentComposerReplyStore
        .getState()
        .settleRunningReplies("conv-existing");
    });

    // THEN it settles nothing, so no reply toast goes up for a turn this send
    // was never in, and the send is still owed its own reply.
    expect(settled).toBe(0);
    expect(awaitingState("conv-existing")).toEqual({
      acknowledged: false,
      queued: false,
    });
  });

  test("a queued response acknowledges the send as queued", async () => {
    // GIVEN a daemon that parks the message behind a turn already running.
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

    // WHEN the send goes out.
    await act(async () => {
      await result.current.submit();
    });

    // THEN the running turn's terminal is not this send's: it waits for the
    // dequeue that starts its own.
    expect(awaitingState("conv-existing")).toEqual({
      acknowledged: true,
      queued: true,
    });
  });

  test("a response leaves a send the stream has queued alone", async () => {
    // GIVEN a send the stream has already parked in the queue.
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));
    useDocumentComposerReplyStore
      .getState()
      .markReplyQueued("conv-existing", sentOptions(0).clientMessageId);

    // WHEN the POST answers, saying the daemon took the message for a turn.
    await act(async () => {
      settle(sentResult("conv-existing"));
      await submitted;
    });

    // THEN the ordered stream keeps the send queued: the response says nothing
    // about a send it took for a turn, so a terminal there is the running
    // turn's rather than this send's.
    expect(awaitingState("conv-existing")).toEqual({
      acknowledged: true,
      queued: true,
    });
  });

  test("a queued response leaves a send the stream is running alone", async () => {
    // GIVEN a send the stream has already echoed back as running.
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));
    useDocumentComposerReplyStore
      .getState()
      .markReplyRunning("conv-existing", sentOptions(0).clientMessageId);

    // WHEN the POST answers with the queue it was parked in when it landed.
    await act(async () => {
      settle({
        ok: true,
        queued: true,
        assistantId: ASSISTANT_ID,
        conversationId: "conv-existing",
        requestId: "req-1",
      });
      await submitted;
    });

    // THEN the send stays running, so the terminal for the turn it is in
    // settles it.
    expect(awaitingState("conv-existing")).toEqual({
      acknowledged: true,
      queued: false,
    });
  });

  test("a send the daemon answered under another id waits on that row", async () => {
    // GIVEN the legacy `conversationKey` path, which answers with the row the
    // daemon minted rather than the key that went out.
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> =>
        sentResult("conv-minted"),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-key");

    // WHEN the send goes out.
    await act(async () => {
      await result.current.submit();
    });

    // THEN the entry moved onto the answered row and is running there: no
    // stream event named the nonce and the row together, so on a daemon whose
    // events carry no nonce the response is the one signal the daemon took
    // the send in, and the terminal on that row is what settles it.
    expect(awaitingState("conv-key")).toBeUndefined();
    expect(awaitingState("conv-minted")).toEqual({
      acknowledged: true,
      queued: false,
    });
  });

  test("a queued send the daemon answered under another id is acknowledged there", async () => {
    // GIVEN the legacy `conversationKey` path answering that it parked the
    // message under the row it minted.
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => ({
        ok: true,
        queued: true,
        assistantId: ASSISTANT_ID,
        conversationId: "conv-minted",
        requestId: "req-1",
      }),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-key");

    // WHEN the send goes out.
    await act(async () => {
      await result.current.submit();
    });

    // THEN the queue mark addresses the row the daemon answered with, where
    // the entry lives once the id has moved.
    expect(awaitingState("conv-key")).toBeUndefined();
    expect(awaitingState("conv-minted")).toEqual({
      acknowledged: true,
      queued: true,
    });
  });

  test("a refused send leaves nothing to acknowledge", async () => {
    // GIVEN a daemon that answers and refuses the message.
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => ({
        ok: false,
        status: 500,
        error: { detail: "boom" },
      }),
    );
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    // WHEN the send goes out.
    await act(async () => {
      await result.current.submit();
    });

    // THEN no turn will run for it, so the entry is gone rather than
    // acknowledged.
    expect(result.current.status).toBe("error");
    expect(awaitingState("conv-existing")).toBeUndefined();
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
    // POST answers: the stream echoes the send back, and the terminal ends
    // the wait and takes the mark down with it.
    useDocumentComposerReplyStore
      .getState()
      .markReplyRunning("conv-existing", sentOptions(0).clientMessageId);
    useDocumentComposerReplyStore
      .getState()
      .settleRunningReplies("conv-existing");
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
    expect(takeHeldMessage(SURFACE_ID)).toBeNull();
    // The incoming assistant's composer is untouched and still sendable.
    expect(useComposerStore.getState().documentInput).toBe(
      "for the second assistant",
    );
    expect(result.current.status).toBe("idle");
  });

  test("closing the document while its conversation is minted holds its full payload", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    const settleMint = deferConversationsPost();
    useComposerStore.setState({
      documentInput: "waiting for the conversation",
      documentAttachments: [UPLOADED_ATTACHMENT],
    });
    const { result, unmount } = renderSubmit("");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(conversationsPostMock).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      settleMint();
      await submitted;
    });

    expect(documentsByIdConversationsPostMock).not.toHaveBeenCalled();
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(takeHeldMessage(SURFACE_ID)).toEqual({
      assistantId: ASSISTANT_ID,
      surfaceId: SURFACE_ID,
      content: "waiting for the conversation",
      attachments: [UPLOADED_ATTACHMENT],
    });
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
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
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

  test("closing the document while it is being linked holds its full payload", async () => {
    // GIVEN a send whose link is out when the host closes the document.
    const settleLink = deferDocumentLink();
    useComposerStore.setState({
      documentInput: "hello",
      documentAttachments: [UPLOADED_ATTACHMENT],
    });
    const { result, unmount } = renderSubmitForAssistant(ASSISTANT_ID, "");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() =>
      expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(1),
    );
    unmount();

    await act(async () => {
      settleLink();
      await submitted;
    });

    // THEN the continuation sends and lists nothing, while the original
    // document keeps everything the user composed.
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(useDocumentComposerReplyStore.getState().pendingReplies.size).toBe(
      0,
    );
    expect(useConversationStore.getState().processingConversationIds.size).toBe(
      0,
    );
    expect(takeHeldMessage(SURFACE_ID)).toEqual({
      assistantId: ASSISTANT_ID,
      surfaceId: SURFACE_ID,
      content: "hello",
      attachments: [UPLOADED_ATTACHMENT],
    });
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
    expect(takeHeldMessage(SURFACE_ID)).toBeNull();
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

  test("a failed link after a document switch holds the first document's message", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    const settleLink = deferDocumentLink(false);
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

    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(takeHeldMessage(SURFACE_ID)).toEqual({
      assistantId: ASSISTANT_ID,
      surfaceId: SURFACE_ID,
      content: "about the first doc",
      attachments: [],
    });
    expect(useComposerStore.getState().documentInput).toBe(
      "about the second doc",
    );
    expect(result.current.status).toBe("idle");
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

  test("a send resolving under a former owner leaves the new owner's nonce alone", async () => {
    // GIVEN a fresh draft on a mint-capable assistant, whose send is still
    // waiting on the conversation the daemon is minting for it.
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    const settleMint = deferConversationsPost();
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "",
    });
    let submittedFirst: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedFirst = result.current.submit();
    });
    await waitFor(() => expect(conversationsPostMock).toHaveBeenCalledTimes(1));

    // WHEN the hook moves to a second document that sends before the first one
    // resumes, and the first one's mint then settles so it reaches its POST.
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
      settleMint();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(2));

    // THEN the second document's send is still listed under the nonce it went
    // out with: the older send has no claim on the composer's retry handle.
    expect(awaitingSends("conv-b").map((p) => p.clientMessageId)).toEqual([
      secondNonce,
    ]);

    // ... so its retry after an ambiguous failure carries that same nonce,
    // which is what lets the daemon dedupe a message it already holds.
    await act(async () => {
      failSecond();
      await submittedSecond;
      await submittedFirst;
    });
    postChatMessageMock = mock(defaultPostChatMessage);
    await act(async () => {
      await result.current.submit();
    });

    expect(sentOptions(0).clientMessageId).toBe(secondNonce);
  });

  test("a send resolving under a former owner carries a nonce of its own", async () => {
    // GIVEN a fresh draft on a mint-capable assistant, whose send is still
    // waiting on the conversation the daemon is minting for it.
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    const settleMint = deferConversationsPost();
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "",
    });
    let submittedFirst: Promise<void> = Promise.resolve();
    await act(async () => {
      submittedFirst = result.current.submit();
    });
    await waitFor(() => expect(conversationsPostMock).toHaveBeenCalledTimes(1));

    // WHEN the hook moves to a second document that sends before the first one
    // resumes, and the first one's mint then settles so it reaches its POST.
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
      settleMint();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(2));

    // THEN the first document's send goes out under a nonce of its own, and
    // each send is listed in its own conversation under the one it carries.
    const firstNonce = sentOptions(1).clientMessageId as string;
    expect(firstNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
    expect(
      awaitingSends(MINTED_CONVERSATION_ID).map((p) => p.clientMessageId),
    ).toEqual([firstNonce]);
    expect(awaitingSends("conv-b").map((p) => p.clientMessageId)).toEqual([
      secondNonce,
    ]);

    await act(async () => {
      failSecond();
      await submittedSecond;
      await submittedFirst;
    });
  });
});

describe("an attempt nothing can retry", () => {
  test("an edited retry takes the abandoned attempt's entry off the list", async () => {
    // GIVEN a send that threw, listed for a retry that would carry its nonce.
    throwFirstPostChatMessage("conv-existing");
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });
    const firstNonce = sentOptions(0).clientMessageId as string;
    expect(firstNonce).toBeTruthy();
    expect(awaitingSends("conv-existing").length).toBe(1);

    // WHEN the user edits the draft, so the retry mints a nonce of its own
    // and nothing is left holding the first attempt's.
    useComposerStore.getState().setInput("hello, edited", "document");
    await act(async () => {
      await result.current.submit();
    });

    // THEN only the send the daemon actually took in is still listed.
    const secondNonce = sentOptions(1).clientMessageId as string;
    expect(secondNonce).not.toBe(firstNonce);
    expect(awaitingSends("conv-existing")).toEqual([
      {
        clientMessageId: secondNonce,
        acknowledged: false,
        queued: false,
        queuedOnStream: false,
        serverMessageId: "msg-1",
        payload: {
          assistantId: ASSISTANT_ID,
          surfaceId: SURFACE_ID,
          content: "hello, edited",
          attachments: [],
        },
      },
    ]);
    expect(isProcessing("conv-existing")).toBe(true);
  });

  test("an edited retry leaves an acknowledged attempt's entry listed", async () => {
    // GIVEN a send that threw, and a daemon that took it in anyway: the
    // stream echoed it back before the user retried.
    throwFirstPostChatMessage("conv-existing");
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });
    const firstNonce = sentOptions(0).clientMessageId as string;
    act(() => {
      useDocumentComposerReplyStore
        .getState()
        .markReplyRunning("conv-existing", firstNonce);
    });

    // WHEN the user edits the draft, so the retry is a message of its own.
    useComposerStore.getState().setInput("hello, edited", "document");
    await act(async () => {
      await result.current.submit();
    });

    // THEN both sends stay listed, oldest first: a reply is coming for each.
    const secondNonce = sentOptions(1).clientMessageId as string;
    expect(
      awaitingSends("conv-existing").map((p) => p.clientMessageId),
    ).toEqual([firstNonce, secondNonce]);
  });

  test("a document switch keeps a thrown send correlated without a processing mark", async () => {
    // GIVEN a send that threw, still listed for a retry.
    throwFirstPostChatMessage("conv-a");
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "conv-a",
    });

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.status).toBe("error");
    expect(isAwaitingReply("conv-a")).toBe(true);

    // WHEN the composer moves to another document, which takes the draft with
    // it, so a later stream acknowledgment has to decide the recovery copy.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });

    // THEN the nonce remains correlated, but the ambiguous request does not
    // leave the conversation looking active indefinitely.
    expect(isAwaitingReply("conv-a")).toBe(true);
    expect(awaitingSends("conv-a")[0]?.recovering).toBe(true);
    expect(isProcessing("conv-a")).toBe(false);
  });

  test("a document switch while the POST is out leaves the entry listed", async () => {
    // GIVEN a send still in flight for the first document.
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

    // WHEN the composer moves to another document before the POST answers.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });
    expect(isAwaitingReply("conv-a")).toBe(true);

    await act(async () => {
      settle(sentResult("conv-a"));
      await submitted;
    });

    // THEN the send the daemon took in is still listed, waiting for the echo:
    // the reply toast is meant to outlive closing the document.
    expect(awaitingState("conv-a")).toEqual({
      acknowledged: false,
      queued: false,
    });
    expect(isProcessing("conv-a")).toBe(true);
  });

  test("a refused send after a document switch hands its message back to that document", async () => {
    // GIVEN a send still in flight for the first document.
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

    // WHEN the composer moves to another document and only then does the
    // daemon refuse the message, so no composer is left holding it.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });
    await act(async () => {
      settle({ ok: false, status: 500, error: { detail: "boom" } });
      await submitted;
    });

    // THEN the message waits for the document it was written in, and nothing
    // is left owing a reply on the row it went toward.
    expect(takeHeldMessage(SURFACE_ID)).toEqual({
      assistantId: ASSISTANT_ID,
      surfaceId: SURFACE_ID,
      content: "about the first doc",
      attachments: [],
    });
    expect(isAwaitingReply("conv-a")).toBe(false);
  });

  test("a refused send on its own composer holds nothing", async () => {
    // GIVEN a composer that never moved on.
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => ({
        ok: false,
        status: 500,
        error: { detail: "boom" },
      }),
    );
    useComposerStore.getState().setInput("about the doc", "document");
    const { result } = renderSubmit("conv-a");

    // WHEN the daemon refuses the message with that composer still on screen.
    await act(async () => {
      await result.current.submit();
    });

    // THEN the draft the user is looking at is the only copy of it.
    expect(result.current.status).toBe("error");
    expect(takeHeldMessage(SURFACE_ID)).toBeNull();
    expect(useComposerStore.getState().documentInput).toBe("about the doc");
  });

  test("an unmount keeps a thrown send correlated and takes its mark down", async () => {
    // GIVEN a send that threw, still listed for a retry.
    throwFirstPostChatMessage("conv-a");
    useComposerStore.getState().setInput("about the doc", "document");
    const { result, unmount } = renderSubmit("conv-a");

    await act(async () => {
      await result.current.submit();
    });
    expect(isAwaitingReply("conv-a")).toBe(true);

    // WHEN the host closes the document, unmounting the composer.
    unmount();

    // THEN a later stream acknowledgment can still retract the recovery.
    expect(isAwaitingReply("conv-a")).toBe(true);
    expect(awaitingSends("conv-a")[0]?.recovering).toBe(true);
    expect(isProcessing("conv-a")).toBe(false);
  });

  test("a document switch after a thrown send hands its message back to that document", async () => {
    // GIVEN a send that threw with the composer it started on still on screen,
    // so its entry stands for a retry.
    throwFirstPostChatMessage("conv-a");
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "conv-a",
    });

    await act(async () => {
      await result.current.submit();
    });
    expect(isAwaitingReply("conv-a")).toBe(true);

    // WHEN the composer moves to another document, which takes the slot the
    // draft was written in with it.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });

    // THEN the message waits for the document it was written in, correlated
    // with the nonce a later stream acknowledgment will carry.
    expect(takeHeldMessage(SURFACE_ID)).toEqual({
      assistantId: ASSISTANT_ID,
      surfaceId: SURFACE_ID,
      content: "about the first doc",
      attachments: [],
    });
    expect(isAwaitingReply("conv-a")).toBe(true);
    expect(awaitingSends("conv-a")[0]?.recovering).toBe(true);
  });

  test("an unmount while the POST is out leaves the entry listed", async () => {
    // GIVEN a send still in flight.
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("about the doc", "document");
    const { result, unmount } = renderSubmit("conv-a");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // WHEN the composer unmounts before the POST answers.
    unmount();

    await act(async () => {
      settle(sentResult("conv-a"));
      await submitted;
    });

    // THEN the daemon holds the message, and the watcher still owes its toast.
    expect(awaitingState("conv-a")).toEqual({
      acknowledged: false,
      queued: false,
    });
  });

  test("a send that throws after a document switch keeps its nonce correlated", async () => {
    // GIVEN a send in flight for the first document.
    const fail = failPostChatMessage();
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

    // WHEN the composer moves to another document and only then does the POST
    // throw, so the attempt lands with no composer to retry it from.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });
    await act(async () => {
      fail();
      await submitted;
    });

    expect(isAwaitingReply("conv-a")).toBe(true);
    expect(awaitingSends("conv-a")[0]?.recovering).toBe(true);
    expect(isProcessing("conv-a")).toBe(false);
    // The message waits for the document it was written in while the nonce
    // remains available to retract it if the assistant accepted the request.
    expect(takeHeldMessage(SURFACE_ID)).toEqual({
      assistantId: ASSISTANT_ID,
      surfaceId: SURFACE_ID,
      content: "about the first doc",
      attachments: [],
    });
  });

  test("a thrown send whose entry the daemon acknowledged holds nothing when abandoned", async () => {
    // GIVEN a send in flight for the first document, echoed back as running.
    const fail = failPostChatMessage();
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
    act(() => {
      useDocumentComposerReplyStore
        .getState()
        .markReplyRunning("conv-a", awaitingSends("conv-a")[0].clientMessageId);
    });

    // WHEN the composer moves to another document and only then does the POST
    // throw.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });
    await act(async () => {
      fail();
      await submitted;
    });

    // THEN the entry the daemon spoke for stays, message and all: the daemon
    // can still report the send failed, and the watcher hands it back then.
    expect(isAwaitingReply("conv-a")).toBe(true);
    expect(takeHeldMessage(SURFACE_ID)).toBeNull();
  });

  test("a send that throws after an assistant switch hands its message back to its document", async () => {
    // GIVEN a send in flight under the first assistant.
    const fail = failPostChatMessage();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID);

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // WHEN the user switches assistants, which drops the send's entry with
    // every other wait, and only then does the POST throw.
    switchAssistantAway();
    rerender({ assistantId: "assistant-2" });
    await act(async () => {
      fail();
      await submitted;
    });

    // THEN the message waits for the document it was written in.
    expect(takeHeldMessage(SURFACE_ID)).toEqual({
      assistantId: ASSISTANT_ID,
      surfaceId: SURFACE_ID,
      content: "for the first assistant",
      attachments: [],
    });
    expect(detachedSends().size).toBe(0);
  });

  test("an accepted send after an assistant switch stays available for reconciliation", async () => {
    // GIVEN a send in flight under the first assistant.
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID);

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));
    const clientMessageId = sentOptions(0).clientMessageId;
    if (clientMessageId === undefined) {
      throw new Error("expected the document send's nonce");
    }
    useDocumentComposerReplyStore
      .getState()
      .markReplyQueued("conv-a", clientMessageId);

    // WHEN the user switches assistants and only then does the daemon accept
    // the message.
    switchAssistantAway();
    rerender({ assistantId: "assistant-2" });
    await act(async () => {
      settle(sentResult("conv-a"));
      await submitted;
    });

    // THEN the response alone does not discard the payload: an interrupt can
    // answer before its detached handoff persists, and switch-back
    // reconciliation decides the authoritative outcome.
    expect(takeHeldMessage(SURFACE_ID)).toBeNull();
    expect(detachedSends().size).toBe(0);
    expect(detachedQueuedSends().get(clientMessageId)).toEqual({
      conversationId: "conv-a",
      serverMessageId: "msg-1",
      payload: {
        assistantId: ASSISTANT_ID,
        surfaceId: SURFACE_ID,
        content: "for the first assistant",
        attachments: [],
      },
    });
  });

  test("an accepted send survives a switch away and back before its response", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID);

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));
    const clientMessageId = sentOptions(0).clientMessageId;
    if (clientMessageId === undefined) {
      throw new Error("expected the document send's nonce");
    }

    switchAssistantAway();
    rerender({ assistantId: "assistant-2" });
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    rerender({ assistantId: ASSISTANT_ID });
    await act(async () => {
      settle(sentResult("conv-a"));
      await submitted;
    });

    expect(isAwaitingReply("conv-a")).toBe(false);
    expect(detachedSends().size).toBe(0);
    expect(detachedQueuedSends().get(clientMessageId)).toEqual({
      conversationId: "conv-a",
      serverMessageId: "msg-1",
      payload: {
        assistantId: ASSISTANT_ID,
        surfaceId: SURFACE_ID,
        content: "for the first assistant",
        attachments: [],
      },
    });
  });

  test("a queued response after an assistant switch keeps the send for reconciliation", async () => {
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID);

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));
    const clientMessageId = sentOptions(0).clientMessageId;
    if (clientMessageId === undefined) {
      throw new Error("expected the document send's nonce");
    }

    switchAssistantAway();
    rerender({ assistantId: "assistant-2" });
    await act(async () => {
      settle({
        ok: true,
        queued: true,
        assistantId: ASSISTANT_ID,
        conversationId: "conv-a",
        requestId: "req-1",
      });
      await submitted;
    });

    expect(detachedSends().size).toBe(0);
    expect(detachedQueuedSends().get(clientMessageId)).toEqual({
      conversationId: "conv-a",
      serverMessageId: "req-1",
      payload: {
        assistantId: ASSISTANT_ID,
        surfaceId: SURFACE_ID,
        content: "for the first assistant",
        attachments: [],
      },
    });
  });

  test("a send refused after an assistant switch is held for its document once", async () => {
    // GIVEN a send in flight under the first assistant.
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("for the first assistant", "document");
    const { result, rerender } = renderSubmitForAssistant(ASSISTANT_ID);

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // WHEN the user switches assistants and only then does the daemon refuse
    // the message.
    switchAssistantAway();
    rerender({ assistantId: "assistant-2" });
    await act(async () => {
      settle({ ok: false, status: 500, error: { detail: "boom" } });
      await submitted;
    });

    // THEN the message waits for its document as one draft, with no second
    // copy left to join it later.
    expect(takeHeldMessage(SURFACE_ID)).toEqual({
      assistantId: ASSISTANT_ID,
      surfaceId: SURFACE_ID,
      content: "for the first assistant",
      attachments: [],
    });
    expect(detachedSends().size).toBe(0);
  });

  test("a thrown send an assistant switch cut off hands its message back when its composer goes", async () => {
    // GIVEN a send that threw with its composer still on screen, so its entry
    // stands for a retry.
    throwFirstPostChatMessage("conv-a");
    useComposerStore.getState().setInput("about the doc", "document");
    const { result, unmount } = renderSubmit("conv-a");

    await act(async () => {
      await result.current.submit();
    });
    expect(isAwaitingReply("conv-a")).toBe(true);

    // WHEN an assistant switch drops that entry, and the host then closes the
    // document, unmounting the composer that could have retried it.
    switchAssistantAway();
    unmount();

    // THEN the message waits for the document it was written in.
    expect(takeHeldMessage(SURFACE_ID)).toEqual({
      assistantId: ASSISTANT_ID,
      surfaceId: SURFACE_ID,
      content: "about the doc",
      attachments: [],
    });
    expect(detachedSends().size).toBe(0);
  });

  test("a send refused after the app left every assistant holds nothing", async () => {
    // GIVEN a send in flight.
    const settle = deferPostChatMessage();
    useComposerStore.getState().setInput("about the doc", "document");
    const { result, unmount } = renderSubmit("conv-a");

    let submitted: Promise<void> = Promise.resolve();
    await act(async () => {
      submitted = result.current.submit();
    });
    await waitFor(() => expect(postChatMessageMock).toHaveBeenCalledTimes(1));

    // WHEN the user logs out, which leaves no assistant active, drops what
    // the store held and closes the document, and only then does the daemon
    // refuse the message.
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    useDocumentComposerReplyStore.getState().clearAwaitingReplies();
    useDocumentComposerReplyStore.getState().clearHeldMessages();
    unmount();
    await act(async () => {
      settle({ ok: false, status: 500, error: { detail: "boom" } });
      await submitted;
    });

    // THEN no message is held for whoever signs in next.
    expect(useDocumentComposerReplyStore.getState().failedSends.size).toBe(0);
  });

  test("a send that throws under its own owner keeps its entry for the retry", async () => {
    // GIVEN a send that threw with the composer it started on still on screen.
    throwFirstPostChatMessage("conv-existing");
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    // THEN the entry stands: the daemon may hold the message already, and the
    // unchanged draft retries under the same nonce for it to dedupe.
    expect(result.current.status).toBe("error");
    expect(isAwaitingReply("conv-existing")).toBe(true);
    expect(isProcessing("conv-existing")).toBe(true);

    await act(async () => {
      await result.current.submit();
    });
    expect(sentOptions(1).clientMessageId).toBe(
      sentOptions(0).clientMessageId as string,
    );
    expect(awaitingSends("conv-existing").length).toBe(1);
  });

  test("an abandoned attempt leaves the conversation's other pending send marked", async () => {
    // GIVEN a send that threw, and another send the daemon is running on the
    // same conversation.
    throwFirstPostChatMessage("conv-a");
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "conv-a",
    });

    await act(async () => {
      await result.current.submit();
    });
    const abandonedNonce = sentOptions(0).clientMessageId as string;
    expect(abandonedNonce).not.toBe("other-nonce");
    act(() => {
      useDocumentComposerReplyStore
        .getState()
        .startAwaitingReply("conv-a", "other-nonce");
      useDocumentComposerReplyStore
        .getState()
        .markReplyRunning("conv-a", "other-nonce");
    });

    // WHEN the composer moves on, so nothing can retry the thrown send.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });

    // THEN the ambiguous attempt stays correlated without contributing a
    // marker, and the mark stands for the other send still running there.
    expect(awaitingSends("conv-a").map((p) => p.clientMessageId)).toEqual([
      abandonedNonce,
      "other-nonce",
    ]);
    expect(awaitingSends("conv-a")[0]?.recovering).toBe(true);
    expect(isProcessing("conv-a")).toBe(true);
  });

  test("an abandoned attempt leaves a handed-off conversation marked", async () => {
    // GIVEN a document send that handed off to queued work still running
    // under the marker it left standing, and a later send that threw.
    useDocumentComposerReplyStore.getState().markHandedOff("conv-a");
    throwFirstPostChatMessage("conv-a");
    useComposerStore.getState().setInput("about the first doc", "document");
    const { result, rerender } = renderSubmitFor({
      surfaceId: SURFACE_ID,
      conversationId: "conv-a",
    });

    await act(async () => {
      await result.current.submit();
    });
    expect(isProcessing("conv-a")).toBe(true);

    // WHEN the composer moves on, so nothing can retry the thrown send.
    rerender({ doc: { surfaceId: "surf-2", conversationId: "conv-b" } });

    // THEN the thrown send stays correlated without owning the mark, which
    // stands for the queued work the handoff announced.
    expect(awaitingSends("conv-a")).toHaveLength(1);
    expect(awaitingSends("conv-a")[0]?.recovering).toBe(true);
    expect(isProcessing("conv-a")).toBe(true);
  });
});
