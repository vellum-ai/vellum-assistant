/**
 * Tests for `resolveDocumentConversationId` / `persistDocumentConversationId` /
 * `linkDocumentConversationIfNeeded` / `rekeyOpenedDocumentConversation`, the
 * conversation-id fallback and re-keying shared by
 * `document-viewer-page.tsx`'s "Submit Feedback", `use-send-message.ts`, and
 * `use-document-composer-submit.ts`. Uses the real `edit-chat-session`
 * (sessionStorage), conversation-selection, and viewer-store modules; only the
 * daemon POST is mocked.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const documentsByIdConversationsPostMock = mock(async () => ({
  data: { success: true },
}));
// Spread the real SDK so unrelated exports (e.g. soundsAvailableGet, imported
// by other modules in this graph) survive the partial mock instead of
// vanishing at link time.
const daemonSdk = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  documentsByIdConversationsPost: (...args: unknown[]) =>
    documentsByIdConversationsPostMock(...(args as [])),
}));

const { getEditChatConversationId } = await import("@/utils/edit-chat-session");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useViewerStore } = await import("@/stores/viewer-store");
const {
  linkDocumentConversationIfNeeded,
  persistDocumentConversationId,
  rekeyOpenedDocumentConversation,
  resolveDocumentConversationId,
} = await import("@/domains/chat/utils/document-conversation");

const ASSISTANT_ID = "assistant-1";
const SURFACE_ID = "surf-1";

const OPENED_DOC = {
  source: "document",
  surfaceId: SURFACE_ID,
  conversationId: "conv-draft",
  documentName: "README.md",
  content: "# Hello",
} as const;

beforeEach(() => {
  window.sessionStorage.clear();
  documentsByIdConversationsPostMock.mockClear();
  useViewerStore.setState({ openedDocumentState: null });
});

afterEach(() => {
  window.sessionStorage.clear();
  useViewerStore.setState({ openedDocumentState: null });
});

describe("resolveDocumentConversationId", () => {
  test("prefers the document's own linked conversation", () => {
    const id = resolveDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "conv-linked" },
      ASSISTANT_ID,
    );
    expect(id).toBe("conv-linked");
  });

  test("falls back to the session-cached id when the document has none", () => {
    persistDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
      "conv-cached",
    );

    const id = resolveDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
    );
    expect(id).toBe("conv-cached");
  });

  test("mints a fresh id without persisting it", () => {
    const id = resolveDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
    );
    expect(id).toBeTruthy();
    expect(useConversationStore.getState().draftConversationIds.has(id)).toBe(
      true,
    );
    // Not cached: a caller that never confirms this id is good (see
    // `persistDocumentConversationId`) must not leave it recoverable from
    // session storage, or the next resolution would reuse a dead draft.
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBeNull();
  });

  test("an unpersisted resolution mints a new id every time, never reusing the last draft", () => {
    const first = resolveDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
    );
    const second = resolveDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
    );
    // Nothing persisted the first id, so it left no trace to be reused: a
    // retry after a failed send must not resend a dead cached draft id.
    expect(second).not.toBe(first);
  });

  test("a repeat resolution reuses a minted id once it has been persisted", () => {
    const doc = { surfaceId: SURFACE_ID, conversationId: "" };
    const first = resolveDocumentConversationId(doc, ASSISTANT_ID);
    persistDocumentConversationId(doc, ASSISTANT_ID, first);

    const second = resolveDocumentConversationId(doc, ASSISTANT_ID);
    expect(second).toBe(first);
  });
});

describe("persistDocumentConversationId", () => {
  test("caches a fresh or reused id for the next resolution", () => {
    persistDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
      "conv-minted",
    );
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBe(
      "conv-minted",
    );
  });

  test("no-ops when the id matches the document's own conversation id", () => {
    persistDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "conv-1" },
      ASSISTANT_ID,
      "conv-1",
    );
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBeNull();
  });
});

describe("linkDocumentConversationIfNeeded", () => {
  test("does not call the daemon when the resolved id matches the document's own", async () => {
    const linked = await linkDocumentConversationIfNeeded(
      { surfaceId: SURFACE_ID, conversationId: "conv-1" },
      ASSISTANT_ID,
      "conv-1",
    );
    // The link a caller asked for is already in place, so the no-op reports
    // success rather than making the caller special-case it.
    expect(linked).toBe(true);
    expect(documentsByIdConversationsPostMock).not.toHaveBeenCalled();
  });

  test("links a reused or freshly minted id that differs from the document's own", async () => {
    const linked = await linkDocumentConversationIfNeeded(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
      "conv-new",
    );
    expect(linked).toBe(true);
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(1);
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: ASSISTANT_ID, id: SURFACE_ID },
      body: { conversationId: "conv-new" },
      throwOnError: true,
    });
  });

  test("reports a daemon failure as false rather than throwing", async () => {
    documentsByIdConversationsPostMock.mockImplementationOnce(async () => {
      throw new Error("no such route");
    });

    // A caller old enough to be talking to an assistant without the route
    // ignores this; one that just minted a row uses it to hold the turn back.
    await expect(
      linkDocumentConversationIfNeeded(
        { surfaceId: SURFACE_ID, conversationId: "" },
        ASSISTANT_ID,
        "conv-new",
      ),
    ).resolves.toBe(false);
  });
});

describe("rekeyOpenedDocumentConversation", () => {
  test("re-keys the open document and re-links it to the minted conversation", async () => {
    useViewerStore.setState({ openedDocumentState: OPENED_DOC });

    await rekeyOpenedDocumentConversation(
      ASSISTANT_ID,
      "conv-draft",
      "conv-minted",
    );

    // Only the conversation id moves: the document itself is the same one.
    expect(useViewerStore.getState().openedDocumentState).toEqual({
      ...OPENED_DOC,
      conversationId: "conv-minted",
    });
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(1);
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: ASSISTANT_ID, id: SURFACE_ID },
      body: { conversationId: "conv-minted" },
      throwOnError: true,
    });
  });

  test("no-ops when no document is open", async () => {
    await rekeyOpenedDocumentConversation(
      ASSISTANT_ID,
      "conv-draft",
      "conv-minted",
    );

    expect(useViewerStore.getState().openedDocumentState).toBeNull();
    expect(documentsByIdConversationsPostMock).not.toHaveBeenCalled();
  });

  test("no-ops for a read-only workspace file preview", async () => {
    const preview = {
      source: "workspace-file-preview",
      workspacePath: "data/rows.csv",
      documentName: "rows.csv",
      previewKind: "csv",
    } as const;
    useViewerStore.setState({ openedDocumentState: preview });

    await rekeyOpenedDocumentConversation(
      ASSISTANT_ID,
      "conv-draft",
      "conv-minted",
    );

    expect(useViewerStore.getState().openedDocumentState).toBe(preview);
    expect(documentsByIdConversationsPostMock).not.toHaveBeenCalled();
  });

  test("no-ops when the open document is on a different conversation", async () => {
    // The mint was for some other conversation's draft: re-keying here would
    // move this document off the conversation it is actually open against.
    useViewerStore.setState({ openedDocumentState: OPENED_DOC });

    await rekeyOpenedDocumentConversation(
      ASSISTANT_ID,
      "conv-someone-else",
      "conv-minted",
    );

    expect(useViewerStore.getState().openedDocumentState).toBe(OPENED_DOC);
    expect(documentsByIdConversationsPostMock).not.toHaveBeenCalled();
  });
});
