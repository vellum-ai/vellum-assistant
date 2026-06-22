import { afterEach, describe, expect, mock, test } from "bun:test";

let mockHotkeys: unknown = null;

// Order matters: `mock.module("./settings", …)` must run before any
// `import` of `./commands`, because `./commands` imports `./settings` at
// the top level. The static `import` form would resolve `./settings`
// first — before this `mock.module` line runs — and bind the real
// `readHotkeyOverride`. Using `await import("./commands")` after the mock
// ensures the mocked module graph is in place when `./commands` is
// evaluated. Subsequent test files copying this template should
// preserve the same ordering.
// `mock.module` mutates the global module registry, so this mock leaks into
// any other test file evaluated in the same run. Provide the full `./settings`
// export surface (not just the one function this file exercises) so a sibling
// module — e.g. `hotkeys.ts`, which imports `writeSetting`/`onSettingChange` —
// still resolves its imports regardless of file order.
mock.module("./settings", () => ({
  readHotkeyOverride: (key: string) => {
    if (mockHotkeys && typeof mockHotkeys === "object") {
      const value = (mockHotkeys as Record<string, unknown>)[key];
      return typeof value === "string" ? value : null;
    }
    return null;
  },
  readSetting: () => null,
  writeSetting: () => {},
  onSettingChange: () => () => {},
}));

const { DEFAULT_ACCELERATORS, resolveAccelerator } = await import("./commands");

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
