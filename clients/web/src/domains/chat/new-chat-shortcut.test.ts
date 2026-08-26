import { afterEach, describe, expect, mock, test } from "bun:test";

// Shortcut hints follow the host OS; pin macOS so the glyph assertions below
// hold on Linux CI runners too.
Object.defineProperty(navigator, "platform", {
  value: "MacIntel",
  configurable: true,
});
let electron = false;

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electron,
}));

const { newChatAccelerator, newChatShortcutHint } = await import(
  "@/domains/chat/new-chat-shortcut"
);

describe("newChatShortcutHint", () => {
  afterEach(() => {
    electron = false;
  });

  test("Electron hosts advertise Cmd/Ctrl+N", () => {
    electron = true;
    expect(newChatAccelerator()).toBe("CmdOrCtrl+N");
    expect(newChatShortcutHint()).toBe("⌘N");
  });

  test("the web host advertises the in-app Cmd/Ctrl+Shift+O chord", () => {
    electron = false;
    expect(newChatAccelerator()).toBe("CmdOrCtrl+Shift+O");
    expect(newChatShortcutHint()).toBe("⌘⇧O");
  });
});
