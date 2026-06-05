import { afterEach, describe, expect, mock, test } from "bun:test";

// Control the host branch directly so each case exercises one transport.
let runningInElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => runningInElectron,
}));

const { getHotkeys, setHotkey, onHotkeysChange } = await import("./hotkeys");

afterEach(() => {
  runningInElectron = false;
  delete (window as { vellum?: unknown }).vellum;
});

describe("getHotkeys", () => {
  test("resolves to an empty catalog off Electron", async () => {
    const get = mock(() => Promise.resolve([]));
    (window as { vellum?: unknown }).vellum = { hotkeys: { get } };

    expect(await getHotkeys()).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  test("reads the catalog over the bridge on Electron", async () => {
    runningInElectron = true;
    const get = mock(() => Promise.resolve([]));
    (window as { vellum?: unknown }).vellum = { hotkeys: { get } };

    await getHotkeys();

    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("setHotkey", () => {
  test("persists the override over the bridge on Electron", async () => {
    runningInElectron = true;
    const set = mock(() => Promise.resolve());
    (window as { vellum?: unknown }).vellum = { hotkeys: { set } };

    await setHotkey("newConversation", "CmdOrCtrl+N");

    expect(set).toHaveBeenCalledWith("newConversation", "CmdOrCtrl+N");
  });
});

describe("onHotkeysChange", () => {
  test("returns a no-op unsubscribe off Electron", () => {
    const onChange = mock(() => () => {});
    (window as { vellum?: unknown }).vellum = { hotkeys: { onChange } };

    expect(() => onHotkeysChange(() => {})()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});

// Version skew: a newer web bundle can run against an older preload whose
// platform is still "electron" but which predates the hotkeys channel. Every
// wrapper must degrade to its safe fallback rather than throw — the settings
// route mounts these on navigation.
describe("older preload lacking the hotkeys channel", () => {
  test("getHotkeys resolves empty, setHotkey no-ops, onChange returns no-op", async () => {
    runningInElectron = true;
    (window as { vellum?: unknown }).vellum = { platform: "electron" };

    expect(await getHotkeys()).toEqual([]);
    await expect(setHotkey("newConversation", null)).resolves.toBeUndefined();
    expect(() => onHotkeysChange(() => {})()).not.toThrow();
  });
});
