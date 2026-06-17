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
mock.module("@/utils/local-settings", () => ({
  getLocalSetting: (key: string, fallback: string) =>
    localSettingsStore.get(key) ?? fallback,
  setLocalSetting: (key: string, value: string) => {
    localSettingsStore.set(key, value);
  },
}));

// Mock the upload dependency — we're testing draft logic, not uploads.
mock.module("@/domains/chat/api/messages", () => ({
  uploadChatAttachment: mock(async () => ({ ok: true, id: "mock-id" })),
}));
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
});

afterEach(() => {
  getStore().fullReset();
  localSettingsStore.clear();
});

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
