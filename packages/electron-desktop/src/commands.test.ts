import { afterEach, describe, expect, mock, test } from "bun:test";

let mockHotkeys: unknown = null;

mock.module("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

const { configureHotkeySettings, DEFAULT_ACCELERATORS, resolveAccelerator } =
  await import("./commands");

configureHotkeySettings({
  read: () =>
    mockHotkeys && typeof mockHotkeys === "object"
      ? (mockHotkeys as Record<string, string>)
      : {},
  write: () => undefined,
  subscribe: () => () => undefined,
});

afterEach(() => {
  mockHotkeys = null;
});

describe("resolveAccelerator", () => {
  test("returns the default when no override is set", () => {
    mockHotkeys = {};
    expect(resolveAccelerator("newConversation")).toBe(
      DEFAULT_ACCELERATORS.newConversation,
    );
  });

  test("returns the default when `hotkeys` is null", () => {
    mockHotkeys = null;
    expect(resolveAccelerator("currentConversation")).toBe(
      DEFAULT_ACCELERATORS.currentConversation,
    );
  });

  test("returns the user override when set to a non-empty string", () => {
    mockHotkeys = { newConversation: "CmdOrCtrl+Alt+T" };
    expect(resolveAccelerator("newConversation")).toBe("CmdOrCtrl+Alt+T");
  });

  test("treats an empty-string override as a disabled binding", () => {
    mockHotkeys = { newConversation: "" };
    expect(resolveAccelerator("newConversation")).toBe("");
  });

  test("falls back to the default for a non-string override", () => {
    mockHotkeys = { markCurrentUnread: 42 };
    expect(resolveAccelerator("markCurrentUnread")).toBe(
      DEFAULT_ACCELERATORS.markCurrentUnread,
    );
  });

  test("ignores overrides for other commands", () => {
    mockHotkeys = { newConversation: "CmdOrCtrl+Alt+T" };
    expect(resolveAccelerator("markCurrentUnread")).toBe(
      DEFAULT_ACCELERATORS.markCurrentUnread,
    );
  });
});
