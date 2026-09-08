/**
 * Tests for `resolveDocumentConversationId` / `linkDocumentConversationIfNeeded`
 * — the conversation-id fallback shared by `document-viewer-page.tsx`'s
 * "Submit Feedback" and `use-document-composer-submit.ts` (LUM-3384). Uses the
 * real `edit-chat-session` (sessionStorage) and conversation-selection
 * modules; only the daemon POST is mocked.
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
const { linkDocumentConversationIfNeeded, resolveDocumentConversationId } =
  await import("@/domains/chat/utils/document-conversation");

const ASSISTANT_ID = "assistant-1";
const SURFACE_ID = "surf-1";

beforeEach(() => {
  window.sessionStorage.clear();
  documentsByIdConversationsPostMock.mockClear();
});

afterEach(() => {
  window.sessionStorage.clear();
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
    resolveDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "conv-cached" },
      ASSISTANT_ID,
    );

    const id = resolveDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
    );
    expect(id).toBe("conv-cached");
  });

  test("mints a fresh id and persists it when nothing is linked or cached", () => {
    const id = resolveDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
    );
    expect(id).toBeTruthy();
    expect(getEditChatConversationId(ASSISTANT_ID, SURFACE_ID)).toBe(id);
    expect(useConversationStore.getState().draftConversationIds.has(id)).toBe(
      true,
    );
  });

  test("a repeat resolution for the same document reuses the freshly minted id", () => {
    const first = resolveDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
    );
    const second = resolveDocumentConversationId(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
    );
    expect(second).toBe(first);
  });
});

describe("linkDocumentConversationIfNeeded", () => {
  test("does not call the daemon when the resolved id matches the document's own", async () => {
    await linkDocumentConversationIfNeeded(
      { surfaceId: SURFACE_ID, conversationId: "conv-1" },
      ASSISTANT_ID,
      "conv-1",
    );
    expect(documentsByIdConversationsPostMock).not.toHaveBeenCalled();
  });

  test("links a reused or freshly minted id that differs from the document's own", async () => {
    await linkDocumentConversationIfNeeded(
      { surfaceId: SURFACE_ID, conversationId: "" },
      ASSISTANT_ID,
      "conv-new",
    );
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledTimes(1);
    expect(documentsByIdConversationsPostMock).toHaveBeenCalledWith({
      path: { assistant_id: ASSISTANT_ID, id: SURFACE_ID },
      body: { conversationId: "conv-new" },
      throwOnError: true,
    });
  });

  test("swallows a daemon failure rather than throwing", async () => {
    documentsByIdConversationsPostMock.mockImplementationOnce(async () => {
      throw new Error("no such route");
    });

    await expect(
      linkDocumentConversationIfNeeded(
        { surfaceId: SURFACE_ID, conversationId: "" },
        ASSISTANT_ID,
        "conv-new",
      ),
    ).resolves.toBeUndefined();
  });
});
