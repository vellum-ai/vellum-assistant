import { beforeEach, describe, expect, mock, test } from "bun:test";

let quitListener: (() => void) | null = null;
let settingsListener: (() => void) | null = null;
let registrationResults: boolean[] = [];
const registered: string[] = [];
const unregistered: string[] = [];

mock.module("electron", () => ({
  app: {
    on: (_event: string, listener: () => void) => {
      quitListener = listener;
    },
    off: () => undefined,
  },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  globalShortcut: {
    register: (accelerator: string) => {
      registered.push(accelerator);
      return registrationResults.shift() ?? true;
    },
    unregister: (accelerator: string) => {
      unregistered.push(accelerator);
    },
  },
}));

const { configureHotkeySettings } = await import("./commands");
const { installGlobalShortcuts, __resetGlobalShortcutsForTesting } =
  await import("./global-shortcuts");

beforeEach(() => {
  __resetGlobalShortcutsForTesting();
  registered.length = 0;
  unregistered.length = 0;
  registrationResults = [];
  configureHotkeySettings({
    read: () => ({}),
    write: () => undefined,
    subscribe: (listener) => {
      settingsListener = listener;
      return () => {
        settingsListener = null;
      };
    },
  });
});

describe("installGlobalShortcuts", () => {
  test("retries failed registration and unregisters on quit", () => {
    registrationResults = [false, true];
    installGlobalShortcuts({
      handlers: { globalHotkey: () => undefined },
      logger: { info: () => undefined, warn: () => undefined },
    });
    settingsListener?.();

    expect(registered).toEqual([
      "CmdOrCtrl+Shift+G",
      "CmdOrCtrl+Shift+G",
    ]);
    expect(unregistered).toEqual([]);

    quitListener?.();
    expect(unregistered).toEqual(["CmdOrCtrl+Shift+G"]);
  });
});
