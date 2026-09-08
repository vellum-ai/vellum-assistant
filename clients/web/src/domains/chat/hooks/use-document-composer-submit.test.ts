/**
 * Tests for `useDocumentComposerSubmit`, the pinned document composer's
 * submit logic. Covers the conversation-id resolution branches (existing /
 * cached / fresh-mint, with and without server-side minting), the snapshot
 * passed to the sidebar's processing tracking, the success and failure
 * paths, the empty-content/uploading guards, and the reply-toast watcher.
 *
 * `postChatMessage` and `documentsByIdConversationsPost` are mocked (network);
 * `edit-chat-session` (sessionStorage), the composer/conversation stores, and
 * the event bus are real, so the resolution and reply-watch branches are
 * exercised for real rather than asserted against a mock's call args.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import type { PostMessageResult } from "@/domains/chat/api/messages";

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
mock.module("@/domains/chat/api/messages", () => ({
  ...realMessages,
  postChatMessage: (...args: unknown[]) => postChatMessageMock(...(args as [])),
}));

const documentsByIdConversationsPostMock = mock(async () => ({
  data: { success: true },
}));
mock.module("@/generated/daemon/sdk.gen", () => ({
  documentsByIdConversationsPost: (...args: unknown[]) =>
    documentsByIdConversationsPostMock(...(args as [])),
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
const toastSuccessMock = mock((..._args: unknown[]) => {});
const toastErrorMock = mock((..._args: unknown[]) => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    info: (...args: unknown[]) => toastInfoMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
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
const { publish } = await import("@/lib/event-bus");
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

function publishMessageComplete(
  conversationId: string,
  source?: "main" | "aux",
) {
  act(() => {
    publish("sse.event", {
      id: `evt-${conversationId}`,
      emittedAt: new Date().toISOString(),
      message: {
        type: "message_complete",
        conversationId,
        ...(source ? { source } : {}),
      },
    });
  });
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
  useAssistantIdentityStore.setState({ version: null });
  window.sessionStorage.clear();
  postChatMessageMock = mock(defaultPostChatMessage);
  documentsByIdConversationsPostMock.mockClear();
  navigateSpy.mockClear();
  navigateToConversationMock.mockClear();
  toastInfoMock.mockClear();
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
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

  test("a fresh draft on a server-mint-capable assistant omits the wire id and adopts the minted one", async () => {
    useAssistantIdentityStore.setState({ version: "0.9.0" });
    postChatMessageMock = mock(
      async (..._args: unknown[]): Promise<PostMessageResult> => ({
        ok: true,
        assistantId: ASSISTANT_ID,
        conversationId: "conv-server-minted",
        messageId: "msg-1",
      }),
    );
    const { result } = renderSubmit("");
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });

    // The wire field is omitted entirely for the mint request.
    expect(postChatMessageMock.mock.calls[0]?.[1]).toBeNull();
    // The minted id (not the local draft id) is what gets cached and linked.
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBe(
      "conv-server-minted",
    );
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: ASSISTANT_ID, id: SURFACE_ID },
      body: { conversationId: "conv-server-minted" },
      throwOnError: true,
    });
    // The local draft mark is gone: nothing is left registered as an
    // unconfirmed client-side draft once the assistant has minted a row.
    expect(useConversationStore.getState().draftConversationIds.size).toBe(0);
    expect(
      useConversationStore
        .getState()
        .processingConversationIds.has("conv-server-minted"),
    ).toBe(true);

    const options = toastInfoMock.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    expect(navigateToConversationMock).toHaveBeenCalledWith(
      navigateSpy,
      "conv-server-minted",
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
    expect(postChatMessageMock.mock.calls[0]?.[3]).toEqual({
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

  test("a message_complete event for the target conversation fires the Assistant replied toast", async () => {
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });
    expect(
      useConversationStore
        .getState()
        .processingConversationIds.has("conv-existing"),
    ).toBe(true);

    publishMessageComplete("conv-existing");

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(
      useConversationStore
        .getState()
        .processingConversationIds.has("conv-existing"),
    ).toBe(false);
    const options = toastSuccessMock.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    expect(navigateToConversationMock).toHaveBeenCalledWith(
      navigateSpy,
      "conv-existing",
    );
  });

  test("fires even for a brand-new conversation absent from the fetched conversation list", async () => {
    // No `queryClient.setQueryData` seed at all: this conversation does not
    // exist in the list cache the sidebar's own graduation sweep reads, which
    // is exactly the case that sweep cannot answer for (see the hook's
    // docstring). The bus event still carries the id regardless.
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("");

    await act(async () => {
      await result.current.submit();
    });
    const conversationId = postChatMessageMock.mock.calls[0]?.[1] as string;
    expect(
      useConversationStore.getState().processingConversationIds.has(conversationId),
    ).toBe(true);

    publishMessageComplete(conversationId);

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
  });

  test("ignores a message_complete event for a different conversation", async () => {
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    publishMessageComplete("conv-unrelated");

    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("ignores an aux-source message_complete event", async () => {
    useComposerStore.getState().setInput("hello", "document");
    const { result } = renderSubmit("conv-existing");

    await act(async () => {
      await result.current.submit();
    });

    publishMessageComplete("conv-existing", "aux");

    expect(toastSuccessMock).not.toHaveBeenCalled();
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
});
