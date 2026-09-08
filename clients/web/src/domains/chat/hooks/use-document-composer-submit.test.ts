/**
 * Tests for `useDocumentComposerSubmit` — the pinned document composer's
 * submit logic (LUM-3384). Covers the three conversation-id resolution
 * branches (existing / cached / fresh-mint), the success and failure paths,
 * the empty-content/uploading guards, and the reply-toast watcher.
 *
 * `postChatMessage` and `documentsByIdConversationsPost` are mocked (network);
 * `edit-chat-session` (sessionStorage) and the composer/conversation stores
 * are real, so the resolution branches are exercised for real rather than
 * asserted against a mock's call args.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import type { PostMessageResult } from "@/domains/chat/api/messages";

const realMessages = await import("@/domains/chat/api/messages");
let postChatMessageMock = mock(
  async (..._args: unknown[]): Promise<PostMessageResult> => ({
    ok: true,
    assistantId: "assistant-1",
    conversationId: "conv-1",
    messageId: "msg-1",
  }),
);
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
const { getEditChatConversationId, setEditChatConversationId } =
  await import("@/utils/edit-chat-session");
const { useDocumentComposerSubmit } =
  await import("./use-document-composer-submit");

const ASSISTANT_ID = "assistant-1";
const SURFACE_ID = "surf-1";

function renderSubmit(conversationId: string) {
  return renderHook(() =>
    useDocumentComposerSubmit({
      assistantId: ASSISTANT_ID,
      doc: { surfaceId: SURFACE_ID, conversationId },
    }),
  );
}

beforeEach(() => {
  useComposerStore.setState({
    documentInput: "",
    documentAttachments: [],
    documentAttachmentLastError: null,
  });
  useConversationStore.setState({
    processingConversationIds: new Set(),
    processingSnapshots: new Map(),
  });
  window.sessionStorage.clear();
  postChatMessageMock = mock(
    async (..._args: unknown[]): Promise<PostMessageResult> => ({
      ok: true,
      assistantId: ASSISTANT_ID,
      conversationId: "conv-1",
      messageId: "msg-1",
    }),
  );
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

  test("mints and persists a fresh id when nothing is linked or cached", async () => {
    const { result } = renderSubmit("");
    useComposerStore.getState().setInput("hello", "document");

    await act(async () => {
      await result.current.submit();
    });

    const sentConversationId = postChatMessageMock.mock.calls[0]?.[1] as string;
    expect(sentConversationId).toBeTruthy();
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(1);
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBe(
      sentConversationId,
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
    const { result } = renderHook(() =>
      useDocumentComposerSubmit({ assistantId: null, doc: null }),
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

  test("a reply that lands while watching fires the Assistant replied toast", async () => {
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

    act(() => {
      useConversationStore
        .getState()
        .removeProcessingConversationId("conv-existing");
    });

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    const options = toastSuccessMock.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    expect(navigateToConversationMock).toHaveBeenCalledWith(
      navigateSpy,
      "conv-existing",
    );
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
