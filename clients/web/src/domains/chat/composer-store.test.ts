/**
 * Unit tests for composer-store draft lifecycle.
 *
 * Covers: conversation switch save/restore, assistant switch save/delete,
 * draft persistence to localStorage, blob URL revocation, and edge cases
 * around empty/whitespace input.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock local-settings so we can observe localStorage reads/writes without
// touching the real localStorage (happy-dom doesn't persist across tests).
const localSettingsStore = new Map<string, string>();
// Spread the real module rather than enumerating its exports: `mock.module`
// replaces the whole module, so a hand-listed set breaks every importer the
// moment local-settings grows an export it does not name.
const actualLocalSettings = await import("@/utils/local-settings");
mock.module("@/utils/local-settings", () => ({
  ...actualLocalSettings,
  getLocalSetting: (key: string, fallback: string) =>
    localSettingsStore.get(key) ?? fallback,
  setLocalSetting: (key: string, value: string) => {
    localSettingsStore.set(key, value);
    return true;
  },
}));

// Mock the upload dependencies. Hoisted mock fns let the attachment tests
// vary per-call results (server-canonical metadata, stored-blob fetches).
import type { UploadAttachmentResult } from "@/domains/chat/api/messages";

const uploadChatAttachmentMock = mock(
  async (): Promise<UploadAttachmentResult> => ({ ok: true, id: "mock-id" }),
);
mock.module("@/domains/chat/api/messages", () => ({
  uploadChatAttachment: uploadChatAttachmentMock,
}));
const fetchAttachmentContentBlobMock = mock(
  async (): Promise<Blob | null> => null,
);
mock.module(
  "@/domains/chat/components/chat-attachments/download-attachment",
  () => ({
    fetchAttachmentContentBlob: fetchAttachmentContentBlobMock,
    downloadAttachment: mock(async () => {}),
  }),
);
mock.module(
  "@/domains/chat/components/chat-attachments/attachment-image-resize",
  () => ({
    IMAGE_AUTO_RESIZE_SOURCE_LIMIT_BYTES: 100 * 1024 * 1024,
    isAutoResizableImage: () => false,
    prepareImageAttachmentForUpload: async (file: File) => ({
      status: "unchanged" as const,
      file,
    }),
  }),
);

const { useComposerStore } = await import("@/domains/chat/composer-store");

function getStore() {
  return useComposerStore.getState();
}

beforeEach(() => {
  getStore().fullReset();
  localSettingsStore.clear();
  uploadChatAttachmentMock.mockClear();
  fetchAttachmentContentBlobMock.mockClear();
});

afterEach(() => {
  getStore().fullReset();
  localSettingsStore.clear();
});

/** Signature bytes, so a fixture is classified the way the real file would be. */
const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const HEIC_HEADER = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
]);

function fileWithHeader(
  header: Uint8Array<ArrayBuffer>,
  name: string,
  type: string,
): File {
  return new File([header, "trailing-bytes"], name, { type });
}

/** Poll until no attachment is in the transient "uploading" state. */
async function waitForUploadsSettled(expectedCount: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const atts = getStore().attachments;
    if (
      atts.length >= expectedCount &&
      atts.every((att) => att.kind !== "uploading")
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Attachments never settled");
}

// ---------------------------------------------------------------------------
// handleConversationSwitch — save outgoing / restore incoming
// ---------------------------------------------------------------------------

describe("handleConversationSwitch", () => {
  test("saves outgoing draft and restores incoming draft", () => {
    // Load drafts for assistant-1, seed a draft for conv-B.
    getStore().loadAssistantDrafts("assistant-1");
    getStore().saveDraft("conv-B", "saved for B");

    // User types in conv-A.
    getStore().setInput("typing in A");

    // Switch from conv-A → conv-B.
    getStore().handleConversationSwitch({
      previousKey: "conv-A",
      nextKey: "conv-B",
    });

    // Input should now be the saved draft for conv-B.
    expect(getStore().input).toBe("saved for B");
    // Restored draft notice should fire.
    expect(getStore().restoredDraftConversationId).toBe("conv-B");
  });

  test("switching to a conversation with no saved draft clears input", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().setInput("will be saved");

    getStore().handleConversationSwitch({
      previousKey: "conv-A",
      nextKey: "conv-C",
    });

    expect(getStore().input).toBe("");
    expect(getStore().restoredDraftConversationId).toBeNull();
  });

  test("empty input deletes outgoing draft from map", () => {
    getStore().loadAssistantDrafts("assistant-1");
    // Pre-seed a draft for conv-A.
    getStore().saveDraft("conv-A", "old draft");
    // User clears input.
    getStore().setInput("   ");

    getStore().handleConversationSwitch({
      previousKey: "conv-A",
      nextKey: "conv-B",
    });

    // Switch back to conv-A — should be empty (deleted, not "old draft").
    getStore().handleConversationSwitch({
      previousKey: "conv-B",
      nextKey: "conv-A",
    });

    expect(getStore().input).toBe("");
  });

  test("no-op when previousKey equals nextKey", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().setInput("unchanged");

    getStore().handleConversationSwitch({
      previousKey: "conv-A",
      nextKey: "conv-A",
    });

    expect(getStore().input).toBe("unchanged");
  });

  test("no-op when previousKey is null (initial mount)", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().setInput("initial");

    getStore().handleConversationSwitch({
      previousKey: null,
      nextKey: "conv-A",
    });

    expect(getStore().input).toBe("initial");
  });
});

// ---------------------------------------------------------------------------
// loadAssistantDrafts — assistant switch
// ---------------------------------------------------------------------------

describe("loadAssistantDrafts", () => {
  test("loading the same assistant is a no-op (no input change)", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().setInput("still here");

    getStore().loadAssistantDrafts("assistant-1");

    expect(getStore().input).toBe("still here");
  });

  test("switching assistants saves current input to outgoing map (P1 fix)", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().setInput("draft for assistant-1");

    // Switch to assistant-2, providing the current conversation key.
    getStore().loadAssistantDrafts("assistant-2", "conv-A");

    // Input should be cleared (incoming assistant has no draft).
    expect(getStore().input).toBe("");

    // Switch back to assistant-1 — draft should be restored.
    getStore().loadAssistantDrafts("assistant-1", null);
    // The draft was persisted to localStorage for assistant-1.
    const stored = localSettingsStore.get("vellum:chatDrafts:assistant-1");
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed["conv-A"]).toBe("draft for assistant-1");
  });

  test("switching assistants with empty input deletes key from outgoing map (P2 fix)", () => {
    getStore().loadAssistantDrafts("assistant-1");
    // Save a draft, then clear it.
    getStore().saveDraft("conv-A", "initial draft");
    getStore().setInput("");

    // Switch to assistant-2 with conv-A as current conversation.
    getStore().loadAssistantDrafts("assistant-2", "conv-A");

    // The draft should be DELETED, not left stale.
    const stored = localSettingsStore.get("vellum:chatDrafts:assistant-1");
    if (stored) {
      const parsed = JSON.parse(stored);
      expect(parsed["conv-A"]).toBeUndefined();
    }
  });

  test("switching assistants without currentConversationKey skips save", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().setInput("will be lost without key");

    // Switch without providing a conversation key — can't save.
    getStore().loadAssistantDrafts("assistant-2");

    expect(getStore().input).toBe("");
    // The text is lost because we didn't know which conversation to save it under.
    const stored = localSettingsStore.get("vellum:chatDrafts:assistant-1");
    if (stored) {
      const parsed = JSON.parse(stored);
      expect(Object.keys(parsed)).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// saveDraft / clearDraft
// ---------------------------------------------------------------------------

describe("saveDraft and clearDraft", () => {
  test("saveDraft persists to localStorage", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().saveDraft("conv-A", "hello world");

    const stored = localSettingsStore.get("vellum:chatDrafts:assistant-1");
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!)["conv-A"]).toBe("hello world");
  });

  test("saveDraft with empty text deletes the key", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().saveDraft("conv-A", "hello");
    getStore().saveDraft("conv-A", "  ");

    const stored = localSettingsStore.get("vellum:chatDrafts:assistant-1");
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!)["conv-A"]).toBeUndefined();
  });

  test("clearDraft removes the key from storage", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().saveDraft("conv-A", "hello");
    getStore().clearDraft("conv-A");

    const stored = localSettingsStore.get("vellum:chatDrafts:assistant-1");
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!)["conv-A"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// restoreDraftIfEmpty — cold-load restore (page reload)
// ---------------------------------------------------------------------------

describe("restoreDraftIfEmpty", () => {
  beforeEach(() => {
    getStore().setInput("");
    getStore().clearRestoredDraftNotice();
  });

  test("restores a saved draft into an empty composer and fires the notice", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().saveDraft("conv-A", "recovered text");
    getStore().setInput("");

    getStore().restoreDraftIfEmpty("conv-A");

    expect(getStore().input).toBe("recovered text");
    expect(getStore().restoredDraftConversationId).toBe("conv-A");
  });

  test("does not clobber existing composer text (e.g. deep-link prefill)", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().saveDraft("conv-A", "saved draft");
    getStore().setInput("user is mid-sentence");

    getStore().restoreDraftIfEmpty("conv-A");

    expect(getStore().input).toBe("user is mid-sentence");
    expect(getStore().restoredDraftConversationId).toBeNull();
  });

  test("no-op when there is no saved draft for the key", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().setInput("");

    getStore().restoreDraftIfEmpty("conv-unknown");

    expect(getStore().input).toBe("");
    expect(getStore().restoredDraftConversationId).toBeNull();
  });

  test("does not restore a whitespace-only stored draft", () => {
    // Inject a whitespace-only draft directly into the persisted blob so the
    // trim guard is exercised (saveDraft itself never stores whitespace).
    localSettingsStore.set(
      "vellum:chatDrafts:assistant-1",
      JSON.stringify({ "conv-A": "   " }),
    );
    getStore().loadAssistantDrafts("assistant-1");
    getStore().setInput("");

    getStore().restoreDraftIfEmpty("conv-A");

    expect(getStore().input).toBe("");
    expect(getStore().restoredDraftConversationId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Attachment lifecycle basics
// ---------------------------------------------------------------------------

describe("resetAttachments vs fullReset", () => {
  test("resetAttachments clears the attachment list", () => {
    // Manually seed an attachment (skip actual upload).
    useComposerStore.setState({
      attachments: [
        {
          kind: "uploaded",
          localId: "att-1",
          id: "srv-1",
          filename: "file.txt",
          mimeType: "text/plain",
          sizeBytes: 100,
          previewUrl: null,
        },
      ],
    });

    getStore().resetAttachments();

    expect(getStore().attachments).toHaveLength(0);
  });

  test("fullReset clears attachments but NOT input (input reset is loadAssistantDrafts' job)", () => {
    getStore().setInput("hello");
    useComposerStore.setState({
      attachments: [
        {
          kind: "uploaded",
          localId: "att-1",
          id: "srv-1",
          filename: "file.txt",
          mimeType: "text/plain",
          sizeBytes: 100,
          previewUrl: null,
        },
      ],
    });

    getStore().fullReset();

    // Input is NOT cleared — only loadAssistantDrafts resets input.
    expect(getStore().input).toBe("hello");
    expect(getStore().attachments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// setInput — functional updater
// ---------------------------------------------------------------------------

describe("setInput", () => {
  test("accepts a string value", () => {
    getStore().setInput("hello");
    expect(getStore().input).toBe("hello");
  });

  test("accepts a functional updater", () => {
    getStore().setInput("hello");
    getStore().setInput((prev) => prev + " world");
    expect(getStore().input).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// addFiles — server-canonical upload metadata
// ---------------------------------------------------------------------------

describe("addPathReferences", () => {
  test("queues a folder path as a path-reference attachment without triggering an upload", () => {
    getStore().addPathReferences(["/Users/example/Projects/app"]);

    const atts = getStore().attachments;
    expect(atts).toHaveLength(1);
    expect(atts[0].kind).toBe("path-reference");
    if (atts[0].kind === "path-reference") {
      expect(atts[0].path).toBe("/Users/example/Projects/app");
      expect(atts[0].filename).toBe("app");
    }
    expect(uploadChatAttachmentMock).not.toHaveBeenCalled();
  });

  test("ignores blank paths", () => {
    getStore().addPathReferences(["", "   ", "/valid/path"]);

    const atts = getStore().attachments;
    expect(atts).toHaveLength(1);
    if (atts[0].kind === "path-reference") {
      expect(atts[0].path).toBe("/valid/path");
    }
  });

  test("clears prior attachmentLastError when a path is successfully queued", () => {
    useComposerStore.setState({
      attachmentLastError: "old error",
    });

    getStore().addPathReferences(["/some/path"]);

    expect(getStore().attachmentLastError).toBeNull();
  });

  test("strips a trailing slash when computing the display filename", () => {
    getStore().addPathReferences(["/Users/example/Projects/app/"]);

    const [att] = getStore().attachments;
    if (att.kind === "path-reference") {
      expect(att.filename).toBe("app");
    }
  });
});

describe("addFiles upload metadata", () => {
  test("adopts stored metadata and previews the stored bytes when the assistant transcodes", async () => {
    uploadChatAttachmentMock.mockResolvedValueOnce({
      ok: true,
      id: "att-1",
      filename: "IMG_5487.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 111,
    });
    fetchAttachmentContentBlobMock.mockResolvedValueOnce(
      new Blob(["jpeg-bytes"], { type: "image/jpeg" }),
    );

    getStore().addFiles(
      [fileWithHeader(HEIC_HEADER, "IMG_5487.HEIC", "image/heic")],
      "assistant-1",
    );
    await waitForUploadsSettled(1);

    const att = getStore().attachments[0];
    if (att.kind !== "uploaded") {
      throw new Error("expected uploaded attachment");
    }
    expect(att.filename).toBe("IMG_5487.jpg");
    expect(att.mimeType).toBe("image/jpeg");
    expect(att.sizeBytes).toBe(111);
    expect(fetchAttachmentContentBlobMock).toHaveBeenCalledWith(
      "assistant-1",
      "att-1",
    );
  });

  test("skips the stored-bytes fetch when the stored mime matches the local file", async () => {
    uploadChatAttachmentMock.mockResolvedValueOnce({
      ok: true,
      id: "att-2",
      filename: "photo.png",
      mimeType: "image/png",
      sizeBytes: 9,
    });

    getStore().addFiles(
      [fileWithHeader(PNG_HEADER, "photo.png", "image/png")],
      "assistant-1",
    );
    await waitForUploadsSettled(1);

    const att = getStore().attachments[0];
    if (att.kind !== "uploaded") {
      throw new Error("expected uploaded attachment");
    }
    expect(att.mimeType).toBe("image/png");
    expect(fetchAttachmentContentBlobMock).not.toHaveBeenCalled();
  });

  test("still uploads with stored metadata when the stored-bytes fetch fails", async () => {
    uploadChatAttachmentMock.mockResolvedValueOnce({
      ok: true,
      id: "att-3",
      filename: "IMG_1.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 5,
    });
    fetchAttachmentContentBlobMock.mockResolvedValueOnce(null);

    getStore().addFiles(
      [fileWithHeader(HEIC_HEADER, "IMG_1.HEIC", "image/heic")],
      "assistant-1",
    );
    await waitForUploadsSettled(1);

    const att = getStore().attachments[0];
    if (att.kind !== "uploaded") {
      throw new Error("expected uploaded attachment");
    }
    expect(att.filename).toBe("IMG_1.jpg");
    expect(att.mimeType).toBe("image/jpeg");
  });

  test("keeps local metadata when the response omits stored fields", async () => {
    uploadChatAttachmentMock.mockResolvedValueOnce({ ok: true, id: "att-4" });

    getStore().addFiles(
      [fileWithHeader(HEIC_HEADER, "IMG_2.HEIC", "image/heic")],
      "assistant-1",
    );
    await waitForUploadsSettled(1);

    const att = getStore().attachments[0];
    if (att.kind !== "uploaded") {
      throw new Error("expected uploaded attachment");
    }
    expect(att.filename).toBe("IMG_2.HEIC");
    expect(att.mimeType).toBe("image/heic");
    expect(fetchAttachmentContentBlobMock).not.toHaveBeenCalled();
  });
});

describe("addFiles image byte validation", () => {
  test("refuses a file claiming to be a PNG whose bytes are not an image", async () => {
    // GIVEN a .png whose header is corrupt, as a truncated or renamed file is
    getStore().addFiles(
      [
        new File(["not-image-bytes-at-all"], "photo.png", {
          type: "image/png",
        }),
      ],
      "assistant-1",
    );

    // WHEN the attachment settles
    await waitForUploadsSettled(1);

    // THEN it is refused by name, and never reaches the upload endpoint
    const att = getStore().attachments[0];
    if (att.kind !== "failed") {
      throw new Error(`expected failed attachment, got ${att.kind}`);
    }
    expect(att.filename).toBe("photo.png");
    expect(att.error).toBe(
      "This image can't be sent: the file appears to be corrupt or in an unsupported format.",
    );
    expect(uploadChatAttachmentMock).not.toHaveBeenCalled();
  });

  test("keeps the valid images in a batch that contains a corrupt one", async () => {
    // GIVEN two readable images and one corrupt one attached together
    getStore().addFiles(
      [
        fileWithHeader(PNG_HEADER, "good-1.png", "image/png"),
        new File(["garbage"], "bad.png", { type: "image/png" }),
        fileWithHeader(HEIC_HEADER, "good-2.HEIC", "image/heic"),
      ],
      "assistant-1",
    );

    // WHEN the attachments settle
    await waitForUploadsSettled(3);

    // THEN only the corrupt one is refused, and the readable ones upload
    const kinds = new Map(
      getStore().attachments.map((att) => [att.filename, att.kind]),
    );
    expect(kinds.get("bad.png")).toBe("failed");
    expect(kinds.get("good-1.png")).toBe("uploaded");
    expect(kinds.get("good-2.HEIC")).toBe("uploaded");
    expect(uploadChatAttachmentMock).toHaveBeenCalledTimes(2);
  });

  test("leaves a non-image attachment alone whatever its bytes are", async () => {
    // GIVEN a text file, which no image signature can match
    getStore().addFiles(
      [new File(["plain text"], "notes.txt", { type: "text/plain" })],
      "assistant-1",
    );

    // WHEN the attachment settles
    await waitForUploadsSettled(1);

    // THEN it uploads: the image rule applies only to images
    expect(getStore().attachments[0].kind).toBe("uploaded");
    expect(uploadChatAttachmentMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// restoreFailedDraft: parking a failed send's text for its own thread
// ---------------------------------------------------------------------------

describe("restoreFailedDraft", () => {
  /** What the composer would show on opening `key` under the loaded assistant. */
  function draftFor(key: string): string {
    getStore().setInput("");
    getStore().restoreDraftIfEmpty(key);
    return getStore().input;
  }

  test("parks the text where the conversation will look for it", () => {
    getStore().loadAssistantDrafts("assistant-1");

    getStore().restoreFailedDraft("assistant-1", "conv-A", "the lost message");

    expect(draftFor("conv-A")).toBe("the lost message");
  });

  test("leaves an occupied slot alone", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().saveDraft("conv-A", "typed later");

    getStore().restoreFailedDraft("assistant-1", "conv-A", "the lost message");

    expect(draftFor("conv-A")).toBe("typed later");
  });

  test("ignores blank text", () => {
    getStore().loadAssistantDrafts("assistant-1");

    getStore().restoreFailedDraft("assistant-1", "conv-A", "   ");

    expect(draftFor("conv-A")).toBe("");
  });

  test("files into the sending assistant's own storage, not the loaded one", () => {
    // GIVEN the user switched assistants while a send for assistant-1 was in
    // flight, so the in-memory map now belongs to assistant-2
    getStore().loadAssistantDrafts("assistant-1");
    getStore().loadAssistantDrafts("assistant-2");

    getStore().restoreFailedDraft("assistant-1", "conv-A", "the lost message");

    // THEN assistant-2, whose map is live, never sees it
    expect(draftFor("conv-A")).toBe("");

    // AND assistant-1 has it waiting when it is loaded again
    getStore().loadAssistantDrafts("assistant-2");
    getStore().loadAssistantDrafts("assistant-1");
    expect(draftFor("conv-A")).toBe("the lost message");
  });

  test("respects an occupied slot in another assistant's storage too", () => {
    getStore().loadAssistantDrafts("assistant-1");
    getStore().saveDraft("conv-A", "typed later");
    getStore().loadAssistantDrafts("assistant-2");

    getStore().restoreFailedDraft("assistant-1", "conv-A", "the lost message");

    getStore().loadAssistantDrafts("assistant-2");
    getStore().loadAssistantDrafts("assistant-1");
    expect(draftFor("conv-A")).toBe("typed later");
  });
});
