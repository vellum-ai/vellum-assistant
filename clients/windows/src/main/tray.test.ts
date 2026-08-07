import { beforeEach, expect, mock, test } from "bun:test";
import type { Lockfile } from "@vellumai/local-mode/contract";

let watchListener: (() => void) | null = null;
const watchFile = mock(
  (_path: string, _options: unknown, listener: () => void) => {
    watchListener = listener;
  },
);
const unwatchFile = mock(() => undefined);
mock.module("node:fs", () => ({ watchFile, unwatchFile }));

let beforeQuit: (() => void) | null = null;
const trayIcon = { isEmpty: () => false };
mock.module("electron", () => ({
  app: {
    getAppPath: () => "/app",
    isPackaged: false,
    once: (event: string, listener: () => void) => {
      if (event === "before-quit") {
        beforeQuit = listener;
      }
    },
    showAboutPanel: () => undefined,
  },
  nativeImage: { createFromPath: () => trayIcon },
  shell: { openExternal: () => Promise.resolve() },
}));

let currentLockfile: Lockfile = {
  assistants: [{ assistantId: "assistant-1", cloud: "vellum" }],
  activeAssistant: "assistant-1",
};
const getLockfileData = mock(() => ({ ok: true, data: currentLockfile }));
mock.module("@vellumai/local-mode", () => ({
  getLockfileData,
  resolveLockfilePaths: () => ["/config/lockfile.json"],
}));

let trayRuntime: { getLockfile: () => unknown } | null = null;
mock.module("@vellumai/electron-desktop/status-icon", () => ({
  configureStatusIconFallback: () => undefined,
}));
mock.module("@vellumai/electron-desktop/about", () => ({
  openAboutWindow: () => undefined,
}));
mock.module("@vellumai/electron-desktop/tray-model", () => ({
  configureTrayModel: (runtime: { getLockfile: () => unknown }) => {
    trayRuntime = runtime;
  },
  installTray: () => undefined,
}));
mock.module("./main-window", () => ({
  current: () => null,
  ensureVisible: () => undefined,
  toggleVisibility: () => undefined,
}));

const { installWindowsTray } = await import("./tray");

beforeEach(() => {
  beforeQuit = null;
  watchListener = null;
  trayRuntime = null;
  getLockfileData.mockClear();
  watchFile.mockClear();
  unwatchFile.mockClear();
});

test("serves tray menus from the watched lockfile cache", () => {
  installWindowsTray();

  expect(getLockfileData).toHaveBeenCalledTimes(1);
  expect(trayRuntime?.getLockfile()).toEqual(currentLockfile);
  expect(trayRuntime?.getLockfile()).toEqual(currentLockfile);
  expect(getLockfileData).toHaveBeenCalledTimes(1);

  currentLockfile = { assistants: [], activeAssistant: null };
  watchListener?.();

  expect(trayRuntime?.getLockfile()).toEqual(currentLockfile);
  expect(getLockfileData).toHaveBeenCalledTimes(2);

  beforeQuit?.();
  expect(unwatchFile).toHaveBeenCalledWith(
    "/config/lockfile.json",
    expect.any(Function),
  );
});
