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
 * link that stops the first turn from running without the document.
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
const { useDocumentComposerSubmit } =
  await import("./use-document-composer-submit");

const ASSISTANT_ID = "assistant-1";
const SURFACE_ID = "surf-1";

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
    .awaitingReplyConversationIds.has(conversationId);
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
    awaitingReplyConversationIds: new Set(),
  });
  useAssistantIdentityStore.setState({ version: null });
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
  useDocumentComposerReplyStore.setState({
    awaitingReplyConversationIds: new Set(),
  });
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

    // No server-mint support (no identity version set): the freshly minted
    // draft id is sent directly as the wire `conversationId`.
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
    useDocumentComposerReplyStore.getState().stopAwaitingReply("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    // The daemon deduped the retry against a turn that is already over, and
    // nothing in its response says so. Nothing is left waiting, so the next
    // unrelated completion cannot fire an "Assistant replied" toast.
    expect(result.current.status).toBe("sent");
    expect(isAwaitingReply("conv-existing")).toBe(false);
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
    expect(
      useDocumentComposerReplyStore.getState().awaitingReplyConversationIds
        .size,
    ).toBe(0);
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

  test("a send that lands after an assistant switch arms no wait and marks nothing processing", async () => {
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

    // Both the wait and the processing marker watch the outgoing assistant's
    // SSE connection, which is not the one the client is on any more: only an
    // unrelated completion could ever take them down.
    expect(isAwaitingReply("conv-minted")).toBe(false);
    expect(useConversationStore.getState().processingConversationIds.size).toBe(
      0,
    );
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
});
