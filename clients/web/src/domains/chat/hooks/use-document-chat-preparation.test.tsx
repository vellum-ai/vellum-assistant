import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { useChannelReferenceStore } from "@/domains/chat/channel-sidecar/channel-reference-store";
import { useComposerStore, type UploadedAttachment } from "@/domains/chat/composer-store";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import type { DocumentViewerContainerHandle } from "@/domains/chat/components/document-viewer-container";
import type { DisplayAttachment } from "@/domains/chat/types/types";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";

import { useComposerSubmit } from "./use-composer-submit";
import { useDocumentChatPreparation } from "./use-document-chat-preparation";
import type { DocumentEditorSnapshot } from "./use-document-editor-save";

const ATTACHMENT: UploadedAttachment = {
  kind: "uploaded",
  localId: "local-1",
  id: "attachment-1",
  filename: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 12,
  previewUrl: null,
  thumbnailUrl: null,
};
const SNAPSHOT = { title: "Latest title", content: "Latest saved paragraph" };
const OWNER = { assistantId: "assistant-1", conversationId: "conversation-1", surfaceId: "surface-1" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function selectOwner(owner = OWNER) {
  useResolvedAssistantsStore.setState({ activeAssistantId: owner.assistantId });
  useConversationStore.setState({ activeConversationId: owner.conversationId });
  useViewerStore.setState({
    mainView: "document",
    openedDocumentState: {
      source: "document",
      assistantId: owner.assistantId,
      surfaceId: owner.surfaceId,
      conversationId: owner.conversationId,
      documentName: "Loaded title",
      content: "Loaded paragraph",
    },
  });
}

function renderPreparedComposer() {
  const flush = mock(async (): Promise<DocumentEditorSnapshot> => SNAPSHOT);
  const release = mock(() => {});
  let valid = true;
  const begin = mock(() => ({ flush, release, isCurrent: () => valid }));
  const editorRef: { current: DocumentViewerContainerHandle | null } = {
    current: { beginSendPreparation: begin, flushPendingSave: flush, refreshComments: async () => {} },
  };
  const sendMessage = mock(async (_content: string, _attachments?: DisplayAttachment[]) => {});
  const hook = renderHook(
    (props: typeof OWNER & { sendDisabled: boolean; showingDocument: boolean }) => {
      const preparation = useDocumentChatPreparation({ ...props, editorRef });
      const composer = useComposerSubmit({
        assistantId: props.assistantId,
        activeConversationId: props.conversationId,
        inputRef: { current: null },
        isEditing: false,
        editingMessageId: null,
        cancelEditing: () => {},
        canUndoEdit: false,
        sendDisabled: props.sendDisabled,
        typingDisabled: false,
        scrollToLatest: () => {},
        sendMessage,
        prepareSend: props.showingDocument ? preparation.prepareSend : undefined,
      });
      return { ...composer, ...preparation };
    },
    { initialProps: { ...OWNER, sendDisabled: false, showingDocument: true } },
  );
  return { ...hook, flush, release, begin, sendMessage, editorRef, invalidateLease: () => { valid = false; } };
}

beforeEach(() => {
  selectOwner();
  useComposerStore.setState({ input: "Revise this paragraph", attachments: [ATTACHMENT] });
  useQuoteReplyStore.getState().clearStagedQuotes();
  useChannelReferenceStore.getState().clearReference();
});

afterEach(() => {
  cleanup();
  useViewerStore.getState().closeDocument();
  useComposerStore.setState({ input: "", attachments: [] });
});

describe("shared document preparation and composer submit", () => {
  test("awaits the editor before clearing text or attachments and sends exactly once", async () => {
    const saving = deferred<DocumentEditorSnapshot>();
    const { result, flush, begin, release, sendMessage } = renderPreparedComposer();
    flush.mockImplementationOnce(() => saving.promise);
    let pending!: Promise<void>;
    act(() => { pending = result.current.submitMessage(); });
    expect(result.current.preparing).toBe(true);
    expect(useComposerStore.getState().input).toBe("Revise this paragraph");
    expect(useComposerStore.getState().attachments).toEqual([ATTACHMENT]);
    await act(async () => result.current.submitMessage());
    expect(begin).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => { saving.resolve(SNAPSHOT); await pending; });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe("Revise this paragraph");
    expect(sendMessage.mock.calls[0]?.[1]?.[0]?.id).toBe(ATTACHMENT.id);
    expect(release).toHaveBeenCalledTimes(1);
    expect(useComposerStore.getState().input).toBe("");
    expect(useComposerStore.getState().attachments).toEqual([]);
  });

  test("returns the flushed title and body, not the fetched viewer snapshot", async () => {
    const { result, release } = renderPreparedComposer();
    await act(async () => {
      const preparation = await result.current.prepareSend();
      expect(preparation?.snapshot).toEqual(SNAPSHOT);
      expect(preparation?.isCurrent()).toBe(true);
      preparation?.release();
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("a save failure preserves the payload and a successful retry uses normal send", async () => {
    const { result, flush, sendMessage } = renderPreparedComposer();
    flush.mockRejectedValueOnce(new Error("save failed"));
    await act(async () => result.current.submitMessage());
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.error).not.toBeNull();
    expect(useComposerStore.getState().input).toBe("Revise this paragraph");
    expect(useComposerStore.getState().attachments).toEqual([ATTACHMENT]);
    await act(async () => result.current.submitMessage());
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  test.each(["assistant", "conversation", "close", "lease", "editor", "disabled", "draft", "attachment", "unmount"])(
    "%s changes during save cancel without clearing the current payload",
    async (change) => {
      const saving = deferred<DocumentEditorSnapshot>();
      const { result, flush, sendMessage, rerender, unmount, editorRef, invalidateLease } = renderPreparedComposer();
      flush.mockImplementationOnce(() => saving.promise);
      let pending!: Promise<void>;
      act(() => { pending = result.current.submitMessage(); });
      act(() => {
        if (change === "assistant") { useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" }); }
        if (change === "conversation") { useConversationStore.setState({ activeConversationId: "conversation-2" }); }
        if (change === "close") { useViewerStore.getState().closeDocument(); }
        if (change === "lease") { invalidateLease(); }
        if (change === "editor") { editorRef.current = null; }
        if (change === "draft") { useComposerStore.getState().setInput("Newer draft"); }
        if (change === "attachment") { useComposerStore.setState({ attachments: [ATTACHMENT, { ...ATTACHMENT, localId: "local-2", id: "attachment-2" }] }); }
      });
      if (change === "disabled") { rerender({ ...OWNER, sendDisabled: true, showingDocument: true }); }
      if (change === "unmount") { unmount(); }
      await act(async () => { saving.resolve(SNAPSHOT); await pending; });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(useComposerStore.getState().input).toBe(change === "draft" ? "Newer draft" : "Revise this paragraph");
      expect(useComposerStore.getState().attachments).toHaveLength(change === "attachment" ? 2 : 1);
    },
  );

  test.each(["assistant", "conversation", "surface", "chat"])(
    "a hung save cannot block a new %s owner or clear its payload later",
    async (change) => {
      const saving = deferred<DocumentEditorSnapshot>();
      const { result, flush, sendMessage, rerender } = renderPreparedComposer();
      flush.mockImplementationOnce(() => saving.promise);
      let oldPending!: Promise<void>;
      act(() => { oldPending = result.current.submitMessage(); });
      const next = {
        assistantId: change === "assistant" ? "assistant-2" : OWNER.assistantId,
        conversationId: change === "conversation" ? "conversation-2" : OWNER.conversationId,
        surfaceId: change === "surface" ? "surface-2" : OWNER.surfaceId,
      };
      act(() => {
        selectOwner(next);
        if (change === "chat") { useViewerStore.getState().closeDocument(); }
        useComposerStore.getState().setInput("New owner message");
      });
      rerender({ ...next, sendDisabled: false, showingDocument: change !== "chat" });
      await act(async () => result.current.submitMessage());
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[0]).toBe("New owner message");
      act(() => useComposerStore.getState().setInput("Keep newer draft"));
      await act(async () => { saving.resolve(SNAPSHOT); await oldPending; });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(useComposerStore.getState().input).toBe("Keep newer draft");
    },
  );

  test("leaving and returning to the same owner cannot revive an older send", async () => {
    const saving = deferred<DocumentEditorSnapshot>();
    const { result, flush, sendMessage, rerender } = renderPreparedComposer();
    flush.mockImplementationOnce(() => saving.promise);
    let pending!: Promise<void>;
    act(() => { pending = result.current.submitMessage(); });
    const other = { ...OWNER, conversationId: "conversation-2" };
    act(() => selectOwner(other));
    rerender({ ...other, sendDisabled: false, showingDocument: true });
    act(() => selectOwner());
    rerender({ ...OWNER, sendDisabled: false, showingDocument: true });
    await act(async () => { saving.resolve(SNAPSHOT); await pending; });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(useComposerStore.getState().input).toBe("Revise this paragraph");
  });

  test("an old save settling cannot release a newer owner's pending preparation", async () => {
    const first = deferred<DocumentEditorSnapshot>();
    const second = deferred<DocumentEditorSnapshot>();
    const { result, flush, begin, sendMessage, rerender } = renderPreparedComposer();
    flush.mockImplementationOnce(() => first.promise);
    flush.mockImplementationOnce(() => second.promise);
    let oldPending!: Promise<void>;
    act(() => { oldPending = result.current.submitMessage(); });
    const next = { ...OWNER, surfaceId: "surface-2" };
    act(() => { selectOwner(next); useComposerStore.getState().setInput("New owner message"); });
    rerender({ ...next, sendDisabled: false, showingDocument: true });
    let newPending!: Promise<void>;
    act(() => { newPending = result.current.submitMessage(); });
    await act(async () => { first.resolve(SNAPSHOT); await oldPending; });
    expect(result.current.preparing).toBe(true);
    await act(async () => result.current.submitMessage());
    expect(begin).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => { second.resolve(SNAPSHOT); await newPending; });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe("New owner message");
  });

  test("revealing the transcript retains preparation for the associated document", async () => {
    const { result, flush, sendMessage } = renderPreparedComposer();
    act(() => useViewerStore.getState().setMainView("chat"));
    await act(async () => result.current.submitMessage());
    expect(flush).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test.each(["saved", "failed", "closed"])("live voice preparation is lossless when %s", async (outcome) => {
    const saving = deferred<DocumentEditorSnapshot>();
    const { result, flush, release, sendMessage } = renderPreparedComposer();
    flush.mockImplementationOnce(() => saving.promise);
    let preparing!: Promise<boolean>;
    act(() => { preparing = result.current.prepareVoice(); });
    await waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    if (outcome === "closed") { act(() => useViewerStore.getState().closeDocument()); }
    await act(async () => {
      if (outcome === "failed") { saving.reject(new Error("save failed")); }
      else { saving.resolve(SNAPSHOT); }
      expect(await preparing).toBe(outcome === "saved");
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(useComposerStore.getState().input).toBe("Revise this paragraph");
    expect(useComposerStore.getState().attachments).toEqual([ATTACHMENT]);
  });
});
