import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ResolvedHotkey } from "@/runtime/hotkeys";

/**
 * Which accelerator a command has depends on the host, so both are simulated
 * here: `electron` picks the branch and `hotkeys` stands in for the catalog the
 * main process would resolve.
 *
 * These assert the accelerator rather than the rendered glyphs. How an
 * accelerator is drawn belongs to the design library's formatter and is tested
 * there; pinning glyphs here would make this file fail for a change it does
 * not own.
 */
let electron = false;
let hotkeys: ResolvedHotkey[] = [];
let changeListener: ((next: ResolvedHotkey[]) => void) | null = null;

const actualIsElectron = await import("@/runtime/is-electron");
mock.module("@/runtime/is-electron", () => ({
  ...actualIsElectron,
  isElectron: () => electron,
}));

const actualHotkeys = await import("@/runtime/hotkeys");
mock.module("@/runtime/hotkeys", () => ({
  ...actualHotkeys,
  getHotkeys: async () => hotkeys,
  onHotkeysChange: (callback: (next: ResolvedHotkey[]) => void) => {
    changeListener = callback;
    return () => {
      changeListener = null;
    };
  },
}));

const { commandAccelerator, __resetCommandShortcutsForTesting } =
  await import("@/hooks/use-command-shortcut");

function hotkey(key: string, accelerator: string): ResolvedHotkey {
  return {
    key,
    label: key,
    scope: "menu",
    defaultAccelerator: accelerator,
    override: null,
    accelerator,
    rebindable: true,
  };
}

/** Let the catalog promise resolve into the module cache. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  electron = false;
  hotkeys = [];
  changeListener = null;
  __resetCommandShortcutsForTesting();
});

describe("in a browser", () => {
  test("answers with the chord the web app binds for itself", () => {
    expect(commandAccelerator("newConversation")).toBe("CmdOrCtrl+Shift+O");
    expect(commandAccelerator("sidebarToggle")).toBe("CmdOrCtrl+\\");
  });

  test("has no shortcut for a desktop-only command", () => {
    // The web build never binds these, so advertising one would be a lie.
    expect(commandAccelerator("togglePinConversation")).toBeUndefined();
    expect(commandAccelerator("markCurrentUnread")).toBeUndefined();
    expect(commandAccelerator("popOut")).toBeUndefined();
  });

  test("never consults the Electron catalog", async () => {
    hotkeys = [hotkey("togglePinConversation", "CmdOrCtrl+Shift+P")];
    expect(commandAccelerator("togglePinConversation")).toBeUndefined();
    await settle();
    expect(commandAccelerator("togglePinConversation")).toBeUndefined();
  });
});

describe("on the desktop", () => {
  test("answers from the resolved catalog", async () => {
    electron = true;
    hotkeys = [hotkey("togglePinConversation", "CmdOrCtrl+Shift+P")];
    // The first read starts the load rather than blocking on it.
    expect(commandAccelerator("togglePinConversation")).toBeUndefined();
    await settle();
    expect(commandAccelerator("togglePinConversation")).toBe(
      "CmdOrCtrl+Shift+P",
    );
  });

  test("prefers the catalog over the web chord for the same command", async () => {
    electron = true;
    hotkeys = [hotkey("newConversation", "CmdOrCtrl+N")];
    await settle();
    expect(commandAccelerator("newConversation")).toBe("CmdOrCtrl+N");
  });

  test("treats an empty accelerator as no shortcut", async () => {
    electron = true;
    hotkeys = [hotkey("toggleVoice", "")];
    await settle();
    expect(commandAccelerator("toggleVoice")).toBeUndefined();
  });

  test("has no shortcut for a command the catalog omits", async () => {
    electron = true;
    hotkeys = [hotkey("newConversation", "CmdOrCtrl+N")];
    await settle();
    expect(commandAccelerator("find")).toBeUndefined();
  });

  test("follows a rebind broadcast by the main process", async () => {
    electron = true;
    hotkeys = [hotkey("togglePinConversation", "CmdOrCtrl+Shift+P")];
    await settle();

    changeListener?.([hotkey("togglePinConversation", "CmdOrCtrl+Alt+P")]);
    expect(commandAccelerator("togglePinConversation")).toBe("CmdOrCtrl+Alt+P");
  });
});
