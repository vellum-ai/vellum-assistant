import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  shouldHandleShortcut,
  useChatLayoutShortcuts,
} from "./use-chat-layout-shortcuts";

const callbacks = {
  toggleSidebar: mock(() => {}),
  onGoBack: mock(() => {}),
  onGoForward: mock(() => {}),
  onNewConversation: mock(() => {}),
  onToggleVoiceMode: mock(() => {}),
};

beforeEach(() => {
  for (const callback of Object.values(callbacks)) {
    callback.mockClear();
  }
});

afterEach(() => {
  cleanup();
});

describe("shouldHandleShortcut", () => {
  test("accepts the physical Z key with Option/Alt", () => {
    expect(
      shouldHandleShortcut(
        { metaKey: false, ctrlKey: false, altKey: true, key: "Ω", code: "KeyZ" },
        document.body,
        "z",
        "alt",
      ),
    ).toBe(true);
  });

  test("preserves paste-as-plain-text inside text-entry controls", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    expect(
      shouldHandleShortcut(
        { metaKey: false, ctrlKey: false, altKey: true, key: "Ω", code: "KeyZ" },
        textarea,
        "z",
        "alt",
      ),
    ).toBe(false);
    textarea.remove();
  });

  test("preserves editing inside contenteditable elements", () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    document.body.append(editor);
    expect(
      shouldHandleShortcut(
        { metaKey: false, ctrlKey: false, altKey: true, key: "Ω", code: "KeyZ" },
        editor,
        "z",
        "alt",
      ),
    ).toBe(false);
    editor.remove();
  });
});

describe("useChatLayoutShortcuts", () => {
  test("toggles Voice Mode for Option+Z and prevents the browser action", () => {
    renderHook(() => useChatLayoutShortcuts(callbacks));
    const event = new KeyboardEvent("keydown", {
      key: "Ω",
      code: "KeyZ",
      altKey: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(callbacks.onToggleVoiceMode).toHaveBeenCalledTimes(1);
  });

  test("does not intercept Option+Z from a textarea", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    renderHook(() => useChatLayoutShortcuts(callbacks));
    const event = new KeyboardEvent("keydown", {
      key: "Ω",
      code: "KeyZ",
      altKey: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(callbacks.onToggleVoiceMode).not.toHaveBeenCalled();
    textarea.remove();
  });
});
