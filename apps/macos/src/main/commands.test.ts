import { afterEach, describe, expect, mock, test } from "bun:test";

let mockHotkeys: unknown = null;

// Order matters: `mock.module("./settings", …)` must run before any
// `import` of `./commands`, because `./commands` imports `./settings` at
// the top level. The static `import` form would resolve `./settings`
// first — before this `mock.module` line runs — and bind the real
// `readSetting`. Using `await import("./commands")` after the mock
// ensures the mocked module graph is in place when `./commands` is
// evaluated. Subsequent test files copying this template should
// preserve the same ordering.
mock.module("./settings", () => ({
  readSetting: (key: string) => (key === "hotkeys" ? mockHotkeys : null),
  writeSetting: () => undefined,
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

  test("falls back to the default for an empty-string override", () => {
    mockHotkeys = { newConversation: "" };
    expect(resolveAccelerator("newConversation")).toBe(
      DEFAULT_ACCELERATORS.newConversation,
    );
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
