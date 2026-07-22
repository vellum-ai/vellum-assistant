import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { z } from "zod";

// In-memory settings store shared by the mock below. `readHotkeyOverride`
// mirrors the real module's semantics (an explicit "" is a real value; only an
// absent key is `null`) so the catalog/merge logic is exercised faithfully.
let store: Record<string, unknown> = {};
mock.module("./settings", () => ({
  readSetting: (key: string) => (key in store ? store[key] : null),
  writeSetting: (key: string, value: unknown) => {
    store[key] = value;
  },
  readHotkeyOverride: (key: string) => {
    const hotkeys = store["hotkeys"];
    if (hotkeys && typeof hotkeys === "object") {
      const value = (hotkeys as Record<string, unknown>)[key];
      return typeof value === "string" ? value : null;
    }
    return null;
  },
  onSettingChange: () => () => undefined,
}));

// Capture the `handle` registrations so the IPC handlers can be invoked
// directly. The sender-origin guard and schema parsing inside the real
// `handle` are covered by `ipc.test.ts`; here we drive the handler bodies.
type Registration = {
  channel: string;
  fn: (args: unknown[]) => unknown;
};
const handleRegistrations: Registration[] = [];
// `on` is included (as a no-op) even though `hotkeys.ts` only uses `handle`:
// this mock leaks into co-run test files via the global module registry, so
// the full `./ipc` surface keeps siblings that import `on` (e.g.
// `feature-flags.ts`) resolvable regardless of file order.
mock.module("./ipc", () => ({
  handle: (
    channel: string,
    _schema: z.ZodType<unknown[]>,
    fn: (args: unknown[]) => unknown,
  ) => {
    handleRegistrations.push({ channel, fn });
  },
  on: () => {},
}));

// `./hotkeys` (via `./commands`) imports `BrowserWindow` from electron; stub
// the surface the broadcast path touches.
mock.module("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

const { resolveHotkeyCatalog, installHotkeysIpc, __resetForTesting } =
  await import("./hotkeys");

const invoke = (channel: string, args: unknown[]): unknown => {
  const registration = handleRegistrations.find((r) => r.channel === channel);
  if (!registration) throw new Error(`No handler for ${channel}`);
  return registration.fn(args);
};

beforeEach(() => {
  store = {};
  handleRegistrations.length = 0;
  __resetForTesting();
});

describe("resolveHotkeyCatalog", () => {
  test("returns every rebindable command with its compiled default", () => {
    const catalog = resolveHotkeyCatalog();
    expect(catalog.filter((c) => c.rebindable).map((c) => c.key)).toEqual([
      "globalHotkey",
      "quickInput",
      "newConversation",
      "currentConversation",
      "markCurrentUnread",
      "sidebarToggle",
      "popOut",
      "home",
      "previousConversation",
      "nextConversation",
    ]);

    const newConversation = catalog.find((c) => c.key === "newConversation");
    expect(newConversation?.defaultAccelerator).toBe("CmdOrCtrl+N");
    expect(newConversation?.override).toBeNull();
    expect(newConversation?.accelerator).toBe("CmdOrCtrl+N");
    expect(newConversation?.rebindable).toBe(true);
  });

  test("includes reserved, non-rebindable accelerators for conflict checks", () => {
    const find = resolveHotkeyCatalog().find((c) => c.key === "find");
    expect(find?.rebindable).toBe(false);
    expect(find?.accelerator).toBe("CmdOrCtrl+F");
  });

  test("drops a reserved command whose accelerator the user disabled", () => {
    store["hotkeys"] = { find: "" };
    const catalog = resolveHotkeyCatalog();
    expect(catalog.some((c) => c.key === "find")).toBe(false);
  });

  test("reflects a custom override in the effective accelerator", () => {
    store["hotkeys"] = { newConversation: "CmdOrCtrl+Alt+T" };
    const entry = resolveHotkeyCatalog().find((c) => c.key === "newConversation");
    expect(entry?.override).toBe("CmdOrCtrl+Alt+T");
    expect(entry?.accelerator).toBe("CmdOrCtrl+Alt+T");
  });

  test("treats an empty-string override as a disabled binding", () => {
    store["hotkeys"] = { globalHotkey: "" };
    const entry = resolveHotkeyCatalog().find((c) => c.key === "globalHotkey");
    expect(entry?.override).toBe("");
    expect(entry?.accelerator).toBe("");
    expect(entry?.defaultAccelerator).toBe("CmdOrCtrl+Shift+G");
  });
});

describe("vellum:hotkeys:set", () => {
  beforeEach(() => {
    installHotkeysIpc();
  });

  test("persists a valid accelerator, merging into existing overrides", () => {
    store["hotkeys"] = { home: "CmdOrCtrl+Shift+H" };
    invoke("vellum:hotkeys:set", ["newConversation", "CmdOrCtrl+Alt+T"]);
    expect(store["hotkeys"]).toEqual({
      home: "CmdOrCtrl+Shift+H",
      newConversation: "CmdOrCtrl+Alt+T",
    });
  });

  test("stores an empty string to disable a binding", () => {
    invoke("vellum:hotkeys:set", ["globalHotkey", ""]);
    expect(store["hotkeys"]).toEqual({ globalHotkey: "" });
  });

  test("clears an override when passed null", () => {
    store["hotkeys"] = { newConversation: "CmdOrCtrl+Alt+T", home: "CmdOrCtrl+Shift+H" };
    invoke("vellum:hotkeys:set", ["newConversation", null]);
    expect(store["hotkeys"]).toEqual({ home: "CmdOrCtrl+Shift+H" });
  });

  test("rejects an invalid accelerator without writing", () => {
    expect(() =>
      invoke("vellum:hotkeys:set", ["newConversation", "NotAModifier+Q+Z"]),
    ).toThrow(/invalid accelerator/i);
    expect(store["hotkeys"]).toBeUndefined();
  });

  test("rejects an unknown command key without writing", () => {
    expect(() =>
      invoke("vellum:hotkeys:set", ["openSettings", "CmdOrCtrl+,"]),
    ).toThrow(/unknown hotkey command/i);
    expect(store["hotkeys"]).toBeUndefined();
  });
});
