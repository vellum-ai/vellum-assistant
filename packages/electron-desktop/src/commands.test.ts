import { afterEach, describe, expect, mock, test } from "bun:test";

let mockHotkeys: unknown = null;

mock.module("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

const {
  configureHotkeySettings,
  DEFAULT_ACCELERATORS,
  GLOBAL_SHORTCUT_DEFAULTS,
  resolveAccelerator,
} = await import("./commands");

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

describe("compiled accelerator defaults", () => {
  test("no chord is claimed by two commands", () => {
    const owners = new Map<string, string[]>();
    for (const [kind, accelerator] of [
      ...Object.entries(DEFAULT_ACCELERATORS),
      ...Object.entries(GLOBAL_SHORTCUT_DEFAULTS),
    ]) {
      if (!accelerator) {
        continue;
      }
      const claimants = owners.get(accelerator);
      if (claimants) {
        claimants.push(kind);
      } else {
        owners.set(accelerator, [kind]);
      }
    }

    // Electron binds a duplicated chord to whichever menu item it builds
    // first and drops the other silently, so a collision reads as "the
    // shortcut does nothing" rather than as an error.
    const collisions = [...owners.entries()]
      .filter(([, kinds]) => kinds.length > 1)
      .map(([accelerator, kinds]) => `${accelerator}: ${kinds.join(", ")}`);
    expect(collisions).toEqual([]);
  });
});
