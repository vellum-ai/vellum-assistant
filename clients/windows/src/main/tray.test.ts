import { beforeEach, expect, mock, test } from "bun:test";
import type { Lockfile } from "@vellumai/local-mode/contract";

const trayIcon = { isEmpty: () => false };
mock.module("electron", () => ({
  app: {
    getAppPath: () => "/app",
    isPackaged: false,
    showAboutPanel: () => undefined,
  },
  nativeImage: { createFromPath: () => trayIcon },
  shell: { openExternal: () => Promise.resolve() },
}));

let currentLockfile: Lockfile = {
  assistants: [{ assistantId: "assistant-1", cloud: "vellum" }],
  activeAssistant: "assistant-1",
};
const getWatchedLockfile = mock(() => currentLockfile);
mock.module("@vellumai/electron-desktop/lockfile-watcher", () => ({
  getWatchedLockfile,
}));

let flagHandler: ((args: [Record<string, boolean>]) => void) | null = null;
mock.module("./ipc.client", () => ({
  on: (_channel: string, _schema: unknown, handler: typeof flagHandler) => {
    flagHandler = handler;
  },
}));

type TrayRuntime = {
  accelerator: (kind: string) => { accelerator?: string };
  featureEnabled: (flag: string) => boolean;
  getLockfile: () => Lockfile;
  icon: (icon: string) => unknown;
};
let trayRuntime: TrayRuntime | null = null;
mock.module("@vellumai/electron-desktop/status-icon", () => ({
  configureStatusIconFallback: () => undefined,
}));
mock.module("@vellumai/electron-desktop/window-state", () => ({
  readOnboardingActive: () => false,
}));
mock.module("@vellumai/electron-desktop/about", () => ({
  openAboutWindow: () => undefined,
}));
mock.module("@vellumai/electron-desktop/commands", () => ({
  acceleratorOption: (kind: string) =>
    kind === "newConversation" ? { accelerator: "CmdOrCtrl+N" } : {},
}));
const themedIcon = { dark: false };
mock.module("./menu-icon", () => ({
  menuIcon: () => () => themedIcon,
}));
mock.module("@vellumai/electron-desktop/tray-model", () => ({
  configureTrayModel: (runtime: TrayRuntime) => {
    trayRuntime = runtime;
  },
  installTray: () => undefined,
}));
mock.module("./main-window", () => ({
  current: () => null,
  ensureVisible: () => undefined,
  toggleVisibility: () => undefined,
}));
mock.module("@vellumai/electron-desktop/quick-input-window", () => ({
  toggleQuickInput: () => undefined,
}));

const { installWindowsTray } = await import("./tray");
const { installFeatureFlagsIpc, isFeatureEnabled } =
  await import("./feature-flags");

beforeEach(() => {
  trayRuntime = null;
  currentLockfile = {
    assistants: [{ assistantId: "assistant-1", cloud: "vellum" }],
    activeAssistant: "assistant-1",
  };
  getWatchedLockfile.mockClear();
  installFeatureFlagsIpc();
});

test("serves tray menus from the shared lockfile watcher", () => {
  installWindowsTray(() => false);

  expect(trayRuntime?.getLockfile()).toEqual(currentLockfile);
  currentLockfile = { assistants: [], activeAssistant: null };
  expect(trayRuntime?.getLockfile()).toEqual(currentLockfile);
  expect(getWatchedLockfile).toHaveBeenCalledTimes(2);
});

test("reads feature gates from the synchronized flag state", () => {
  installWindowsTray(isFeatureEnabled);

  expect(trayRuntime?.featureEnabled("multi-platform-assistant")).toBe(false);
  flagHandler?.([{ "multi-platform-assistant": true }]);
  expect(trayRuntime?.featureEnabled("multi-platform-assistant")).toBe(true);
});

test("exposes menu accelerators and themed icons", () => {
  installWindowsTray(() => false);

  expect(trayRuntime?.accelerator("newConversation")).toEqual({
    accelerator: "CmdOrCtrl+N",
  });
  expect(trayRuntime?.icon("settings")).toBe(themedIcon);
});
