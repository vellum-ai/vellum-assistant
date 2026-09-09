/**
 * Unit tests for composer-store draft lifecycle.
 *
 * Covers: conversation switch save/restore, assistant switch save/delete,
 * draft persistence to localStorage, blob URL revocation, and edge cases
 * around empty/whitespace input.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import IntlMessageFormat from "intl-messageformat";

import chatEn from "@/i18n/locales/en/chat.json";

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

import type { UploadedAttachment } from "@/domains/chat/composer-store";
import type { DisplayAttachment } from "@/types/attachment-types";

const { MAX_ATTACHMENT_BYTES, useComposerStore } =
  await import("@/domains/chat/composer-store");

function getStore() {
  return useComposerStore.getState();
}

// `fullReset` is deliberately a "main"-slot-only concern (see composer-store's
// `ComposerSlot` docstring), so the document slot's fields are reset directly
// here to keep the two slots from leaking state across tests.
function resetDocumentSlot() {
  useComposerStore.setState({
    documentInput: "",
    documentAttachments: [],
    documentAttachmentLastError: null,
  });
}

beforeEach(() => {
  getStore().fullReset();
  resetDocumentSlot();
  localSettingsStore.clear();
  uploadChatAttachmentMock.mockClear();
  fetchAttachmentContentBlobMock.mockClear();
});

afterEach(() => {
  getStore().fullReset();
  resetDocumentSlot();
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

/**
 * The English catalog message for `key`, rendered the way the app renders it,
 * so an assertion reads the shipped copy rather than a second copy of it.
 */
function attachmentCopy(
  key: keyof typeof chatEn.composerAttachments,
  values: Record<string, string | number> = {},
): string {
  return String(
    new IntlMessageFormat(chatEn.composerAttachments[key], "en").format(values),
  );
}

/** A file too big to queue, described without allocating its bytes. */
function oversizedFile(name: string): File {
  return {
    name,
    type: "application/octet-stream",
    size: MAX_ATTACHMENT_BYTES + 1,
  } as unknown as File;
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

/** Stage one uploaded image in each composer slot, settled and previewed. */
async function uploadOneImagePerSlot(): Promise<{
  mainAtt: UploadedAttachment;
  docAtt: UploadedAttachment;
}> {
  getStore().addFiles(
    [fileWithHeader(PNG_HEADER, "main.png", "image/png")],
    "assistant-1",
  );
  getStore().addFiles(
    [fileWithHeader(PNG_HEADER, "doc.png", "image/png")],
    "assistant-1",
    "document",
  );
  await waitForUploadsSettled(1);
  for (let i = 0; i < 100; i++) {
    if (getStore().documentAttachments.every((a) => a.kind !== "uploading")) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const mainAtt = getStore().attachments[0];
  const docAtt = getStore().documentAttachments[0];
  if (mainAtt?.kind !== "uploaded" || docAtt?.kind !== "uploaded") {
    throw new Error("expected both attachments to have uploaded");
  }
  expect(mainAtt.previewUrl).toBeTruthy();
  expect(docAtt.previewUrl).toBeTruthy();
  return { mainAtt, docAtt };
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
// Attachment error copy: the store runs outside React and reads the catalog
// ---------------------------------------------------------------------------

describe("addFiles attachment error copy", () => {
  test("a missing assistant surfaces the catalog's no-active-assistant message", () => {
    getStore().addFiles(
      [new File(["plain text"], "notes.txt", { type: "text/plain" })],
      null,
    );

    expect(getStore().attachmentLastError).toBe(
      attachmentCopy("noActiveAssistant"),
    );
    expect(getStore().attachments).toHaveLength(0);
  });

  test("one oversized file names the file and the limit from the catalog", () => {
    getStore().addFiles([oversizedFile("huge.bin")], "assistant-1");

    expect(getStore().attachmentLastError).toBe(
      attachmentCopy("fileTooLarge", { name: "huge.bin", limit: "50 MB" }),
    );
  });

  test("several oversized files take the catalog's plural form", () => {
    getStore().addFiles(
      [oversizedFile("huge-1.bin"), oversizedFile("huge-2.bin")],
      "assistant-1",
    );

    expect(getStore().attachmentLastError).toBe(
      attachmentCopy("filesTooLarge", { count: 2 }),
    );
  });

  test("a failed upload with no detail marks the chip with the catalog message", async () => {
    uploadChatAttachmentMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      error: {},
    }));

    getStore().addFiles(
      [new File(["plain text"], "notes.txt", { type: "text/plain" })],
      "assistant-1",
    );
    await waitForUploadsSettled(1);

    const att = getStore().attachments[0];
    if (att.kind !== "failed") {
      throw new Error(`expected failed attachment, got ${att.kind}`);
    }
    expect(att.error).toBe(attachmentCopy("uploadFailed"));
  });

  test("a detail from the assistant wins over the catalog message", async () => {
    uploadChatAttachmentMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 413,
      error: { detail: "Attachment storage is full" },
    }));

    getStore().addFiles(
      [new File(["plain text"], "notes.txt", { type: "text/plain" })],
      "assistant-1",
    );
    await waitForUploadsSettled(1);

    const att = getStore().attachments[0];
    if (att.kind !== "failed") {
      throw new Error(`expected failed attachment, got ${att.kind}`);
    }
    expect(att.error).toBe("Attachment storage is full");
  });
});

// ---------------------------------------------------------------------------
// restoreAttachmentsIfEmpty: staging a failed send's attachments again
// ---------------------------------------------------------------------------

describe("restoreAttachmentsIfEmpty", () => {
  const sent: DisplayAttachment[] = [
    {
      id: "srv-1",
      filename: "one.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      previewUrl: null,
    },
    {
      id: "srv-2",
      filename: "two.txt",
      mimeType: "text/plain",
      sizeBytes: 2,
      previewUrl: null,
    },
  ];

  test("stages the attachments as uploaded entries with fresh local ids", () => {
    getStore().restoreAttachmentsIfEmpty(sent);

    const atts = getStore().attachments;
    expect(atts.map((att) => att.kind)).toEqual(["uploaded", "uploaded"]);
    expect(
      atts.map((att) => (att.kind === "uploaded" ? att.id : null)),
    ).toEqual(["srv-1", "srv-2"]);
    const localIds = atts.map((att) => att.localId);
    expect(new Set(localIds).size).toBe(2);
    for (const localId of localIds) {
      expect(localId).toStartWith("att-");
    }
  });

  test("leaves a slot the user has already staged something into alone", () => {
    const staged: UploadedAttachment = {
      kind: "uploaded",
      localId: "newer-att",
      id: "srv-newer",
      filename: "newer.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      previewUrl: null,
    };
    useComposerStore.setState({ attachments: [staged] });

    getStore().restoreAttachmentsIfEmpty(sent);

    expect(getStore().attachments).toEqual([staged]);
  });

  test("no-ops on an empty list", () => {
    getStore().restoreAttachmentsIfEmpty([]);

    expect(getStore().attachments).toHaveLength(0);
  });

  test("stages into the document slot without touching the main one", () => {
    getStore().restoreAttachmentsIfEmpty(sent, "document");

    expect(getStore().documentAttachments).toHaveLength(2);
    expect(getStore().attachments).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// ComposerSlot ("main" vs "document") isolation
// ---------------------------------------------------------------------------

describe("ComposerSlot isolation", () => {
  test("setInput defaults to the main slot", () => {
    getStore().setInput("typed in main");
    expect(getStore().input).toBe("typed in main");
    expect(getStore().documentInput).toBe("");
  });

  test("setInput('document') writes documentInput without touching input", () => {
    getStore().setInput("main text");
    getStore().setInput("document text", "document");

    expect(getStore().input).toBe("main text");
    expect(getStore().documentInput).toBe("document text");
  });

  test("setInput('document') accepts a functional updater scoped to its own slot", () => {
    getStore().setInput("main");
    getStore().setInput("doc", "document");

    getStore().setInput((prev) => `${prev}!`, "document");

    expect(getStore().documentInput).toBe("doc!");
    expect(getStore().input).toBe("main");
  });

  test("addFiles('document') queues into documentAttachments, not attachments", async () => {
    getStore().addFiles(
      [fileWithHeader(PNG_HEADER, "doc.png", "image/png")],
      "assistant-1",
      "document",
    );

    // Queued synchronously, before the async upload settles.
    expect(getStore().documentAttachments).toHaveLength(1);
    expect(getStore().attachments).toHaveLength(0);

    for (let i = 0; i < 100; i++) {
      if (getStore().documentAttachments.every((a) => a.kind !== "uploading")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(getStore().documentAttachments[0]?.kind).toBe("uploaded");
    expect(getStore().attachments).toHaveLength(0);
  });

  test("an oversized file sets documentAttachmentLastError, not attachmentLastError", () => {
    getStore().addFiles([oversizedFile("huge.bin")], "assistant-1", "document");

    expect(getStore().documentAttachmentLastError).toBe(
      attachmentCopy("fileTooLarge", { name: "huge.bin", limit: "50 MB" }),
    );
    expect(getStore().attachmentLastError).toBeNull();
  });

  test("removeAttachment('document') removes only from documentAttachments", () => {
    useComposerStore.setState({
      attachments: [
        {
          kind: "uploaded",
          localId: "main-att",
          id: "srv-main",
          filename: "main.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          previewUrl: null,
        },
      ],
      documentAttachments: [
        {
          kind: "uploaded",
          localId: "doc-att",
          id: "srv-doc",
          filename: "doc.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          previewUrl: null,
        },
      ],
    });

    getStore().removeAttachment("doc-att", "document");

    expect(getStore().documentAttachments).toHaveLength(0);
    expect(getStore().attachments).toHaveLength(1);
  });

  test("resetAttachments('document') clears only the document slot", () => {
    useComposerStore.setState({
      attachments: [
        {
          kind: "uploaded",
          localId: "main-att",
          id: "srv-main",
          filename: "main.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          previewUrl: null,
        },
      ],
      attachmentLastError: "main error",
      documentAttachments: [
        {
          kind: "uploaded",
          localId: "doc-att",
          id: "srv-doc",
          filename: "doc.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          previewUrl: null,
        },
      ],
      documentAttachmentLastError: "doc error",
    });

    getStore().resetAttachments("document");

    expect(getStore().documentAttachments).toHaveLength(0);
    expect(getStore().documentAttachmentLastError).toBeNull();
    expect(getStore().attachments).toHaveLength(1);
    expect(getStore().attachmentLastError).toBe("main error");
  });

  test("dismissAttachmentError('document') clears only documentAttachmentLastError", () => {
    useComposerStore.setState({
      attachmentLastError: "main error",
      documentAttachmentLastError: "doc error",
    });

    getStore().dismissAttachmentError("document");

    expect(getStore().documentAttachmentLastError).toBeNull();
    expect(getStore().attachmentLastError).toBe("main error");
  });

  test("fullReset() defaults to the main slot and leaves the document slot's own state untouched", () => {
    useComposerStore.setState({
      documentAttachments: [
        {
          kind: "uploaded",
          localId: "doc-att",
          id: "srv-doc",
          filename: "doc.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          previewUrl: null,
        },
      ],
      documentAttachmentLastError: "doc error",
    });

    getStore().fullReset();

    expect(getStore().documentAttachments).toHaveLength(1);
    expect(getStore().documentAttachmentLastError).toBe("doc error");
  });

  test("fullReset('document') clears only the document slot", () => {
    useComposerStore.setState({
      attachments: [
        {
          kind: "uploaded",
          localId: "main-att",
          id: "srv-main",
          filename: "main.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          previewUrl: null,
        },
      ],
      attachmentLastError: "main error",
      documentAttachments: [
        {
          kind: "uploaded",
          localId: "doc-att",
          id: "srv-doc",
          filename: "doc.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          previewUrl: null,
        },
      ],
      documentAttachmentLastError: "doc error",
    });

    getStore().fullReset("document");

    expect(getStore().documentAttachments).toHaveLength(0);
    expect(getStore().documentAttachmentLastError).toBeNull();
    expect(getStore().attachments).toHaveLength(1);
    expect(getStore().attachmentLastError).toBe("main error");
  });

  test("fullReset only revokes the preview URLs belonging to the slot being reset", async () => {
    const revokeSpy = spyOn(URL, "revokeObjectURL");
    try {
      const { mainAtt, docAtt } = await uploadOneImagePerSlot();

      getStore().fullReset();

      // The main slot's own URL is revoked and its attachment cleared...
      expect(revokeSpy).toHaveBeenCalledWith(mainAtt.previewUrl);
      expect(getStore().attachments).toHaveLength(0);
      // ...but the document slot keeps its attachment AND that attachment's
      // preview URL is left alive, not revoked out from under it.
      expect(revokeSpy).not.toHaveBeenCalledWith(docAtt.previewUrl);
      expect(getStore().documentAttachments).toHaveLength(1);
      expect(getStore().documentAttachments[0]).toBe(docAtt);
    } finally {
      revokeSpy.mockRestore();
    }
  });

  test("fullReset('main') revokes a main-slot URL a send already cleared out of the composer", async () => {
    const revokeSpy = spyOn(URL, "revokeObjectURL");
    try {
      const { mainAtt, docAtt } = await uploadOneImagePerSlot();

      // A successful send empties both composers but keeps the URLs alive for
      // the sent message bubbles.
      getStore().resetAttachments();
      getStore().resetAttachments("document");
      expect(revokeSpy).not.toHaveBeenCalledWith(mainAtt.previewUrl);

      getStore().fullReset();

      expect(revokeSpy).toHaveBeenCalledWith(mainAtt.previewUrl);
      expect(revokeSpy).not.toHaveBeenCalledWith(docAtt.previewUrl);
    } finally {
      revokeSpy.mockRestore();
    }
  });

  test("fullReset('document') revokes a document-slot URL a send already cleared out of the composer", async () => {
    const revokeSpy = spyOn(URL, "revokeObjectURL");
    try {
      const { mainAtt, docAtt } = await uploadOneImagePerSlot();

      getStore().resetAttachments();
      getStore().resetAttachments("document");
      expect(revokeSpy).not.toHaveBeenCalledWith(docAtt.previewUrl);

      getStore().fullReset("document");

      expect(revokeSpy).toHaveBeenCalledWith(docAtt.previewUrl);
      expect(revokeSpy).not.toHaveBeenCalledWith(mainAtt.previewUrl);
    } finally {
      revokeSpy.mockRestore();
    }
  });
});
