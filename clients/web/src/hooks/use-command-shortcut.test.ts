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

/**
 * Start the catalog load and let it resolve into the module cache.
 *
 * Reading is what starts the load, so a test that awaits without reading
 * first would settle a fetch that had not been kicked off yet and then
 * assert against an empty cache.
 */
async function loadCatalog(): Promise<void> {
  commandAccelerator("newConversation");
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
    await loadCatalog();
    expect(commandAccelerator("togglePinConversation")).toBeUndefined();
  });
});

describe("on the desktop", () => {
  test("answers from the resolved catalog", async () => {
    electron = true;
    hotkeys = [hotkey("togglePinConversation", "CmdOrCtrl+Alt+P")];
    await loadCatalog();
    // A rebound value the compiled default could not have produced, so this
    // fails if the catalog is ignored in favour of the fallback.
    expect(commandAccelerator("togglePinConversation")).toBe("CmdOrCtrl+Alt+P");
  });

  test("falls back to the shell's compiled menu default before the catalog arrives", () => {
    // A shell too old to report a catalog still registered these, so the hint
    // has to name them rather than go blank.
    electron = true;
    hotkeys = [];
    expect(commandAccelerator("togglePinConversation")).toBe(
      "CmdOrCtrl+Shift+P",
    );
    expect(commandAccelerator("newConversation")).toBe("CmdOrCtrl+N");
  });

  test("prefers the catalog over the web chord for the same command", async () => {
    electron = true;
    hotkeys = [hotkey("newConversation", "CmdOrCtrl+N")];
    await loadCatalog();
    expect(commandAccelerator("newConversation")).toBe("CmdOrCtrl+N");
  });

  test("treats an empty accelerator as no shortcut", async () => {
    electron = true;
    // Paired with a bound sibling so the catalog is non-empty: an empty
    // catalog would answer from the fallback instead, and this must prove the
    // catalog's own "bound to nothing" rather than the absence of one.
    hotkeys = [
      hotkey("toggleVoice", ""),
      hotkey("newConversation", "CmdOrCtrl+N"),
    ];
    await loadCatalog();
    expect(commandAccelerator("toggleVoice")).toBeUndefined();
  });

  test("has no shortcut for a command the catalog omits", async () => {
    electron = true;
    hotkeys = [hotkey("newConversation", "CmdOrCtrl+N")];
    await loadCatalog();
    // The catalog is authoritative once it exists, so a command it omits has
    // no shortcut even though the shell ships a default for it.
    expect(commandAccelerator("find")).toBeUndefined();
  });

  test("follows a rebind broadcast by the main process", async () => {
    electron = true;
    hotkeys = [hotkey("togglePinConversation", "CmdOrCtrl+Shift+P")];
    await loadCatalog();

    changeListener?.([hotkey("togglePinConversation", "CmdOrCtrl+Alt+P")]);
    expect(commandAccelerator("togglePinConversation")).toBe("CmdOrCtrl+Alt+P");
  });
});
