/**
 * Unit tests for use-draft-persistence — keeps the composer draft alive across
 * reloads via debounced autosave, an unload flush, and cold-load restore.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

// Observe draft persistence through a local map instead of the real
// localStorage (happy-dom doesn't persist across tests). Matches the approach
// in composer-store.test.ts.
const localSettingsStore = new Map<string, string>();
mock.module("@/utils/local-settings", () => ({
  getLocalSetting: (key: string, fallback: string) =>
    localSettingsStore.get(key) ?? fallback,
  setLocalSetting: (key: string, value: string) => {
    localSettingsStore.set(key, value);
  },
}));
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
const { useConversationStore } = await import("@/stores/conversation-store");
const { useDraftPersistence } = await import("./use-draft-persistence");

// Comfortably greater than the hook's AUTOSAVE_DEBOUNCE_MS (300).
const DEBOUNCE_WAIT_MS = 400;

function setActiveConversation(id: string | null) {
  act(() => {
    useConversationStore.setState({ activeConversationId: id });
  });
}

function storedDraft(assistantId: string, key: string): string | undefined {
  const raw = localSettingsStore.get(`vellum:chatDrafts:${assistantId}`);
  return raw ? (JSON.parse(raw)[key] as string | undefined) : undefined;
}

beforeEach(() => {
  localSettingsStore.clear();
  useComposerStore.getState().fullReset();
  act(() => {
    useComposerStore.setState({ input: "", restoredDraftConversationId: null });
    useConversationStore.setState({ activeConversationId: null });
  });
});

afterEach(() => {
  cleanup();
  localSettingsStore.clear();
});

describe("cold-load restore", () => {
  test("restores the saved draft for the active conversation on mount", () => {
    useComposerStore.getState().loadAssistantDrafts("assistant-1");
    useComposerStore.getState().saveDraft("conv-A", "recovered after reload");
    act(() => useComposerStore.setState({ input: "" }));
    setActiveConversation("conv-A");

    renderHook(() => useDraftPersistence());

    expect(useComposerStore.getState().input).toBe("recovered after reload");
    expect(useComposerStore.getState().restoredDraftConversationId).toBe(
      "conv-A",
    );
  });

  test("does not clobber text already in the composer", () => {
    useComposerStore.getState().loadAssistantDrafts("assistant-1");
    useComposerStore.getState().saveDraft("conv-A", "saved draft");
    act(() => useComposerStore.setState({ input: "deep-link prefill" }));
    setActiveConversation("conv-A");

    renderHook(() => useDraftPersistence());

    expect(useComposerStore.getState().input).toBe("deep-link prefill");
  });
});

describe("unload flush", () => {
  test("pagehide synchronously persists the in-progress draft", () => {
    useComposerStore.getState().loadAssistantDrafts("assistant-1");
    setActiveConversation("conv-A");
    renderHook(() => useDraftPersistence());

    act(() => {
      useComposerStore.getState().setInput("typed but not yet autosaved");
    });
    // Fire pagehide before the debounce window elapses.
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(storedDraft("assistant-1", "conv-A")).toBe(
      "typed but not yet autosaved",
    );
  });
});

describe("debounced autosave", () => {
  test("persists the draft after the debounce window", async () => {
    useComposerStore.getState().loadAssistantDrafts("assistant-1");
    setActiveConversation("conv-A");
    renderHook(() => useDraftPersistence());

    act(() => {
      useComposerStore.getState().setInput("autosaved text");
    });
    // Nothing written yet — the save is debounced.
    expect(storedDraft("assistant-1", "conv-A")).toBeUndefined();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));
    });

    expect(storedDraft("assistant-1", "conv-A")).toBe("autosaved text");
  });
});
