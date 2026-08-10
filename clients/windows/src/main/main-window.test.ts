import { expect, mock, test } from "bun:test";

const appListeners = new Map<string, () => void>();
const windowListeners = new Map<string, (event?: unknown) => void>();
const webContentsListeners = new Map<string, () => void>();
const hide = mock(() => undefined);
let destroyed = false;
const win = {
  focus: mock(() => undefined),
  hide,
  isDestroyed: () => destroyed,
  isFocused: () => true,
  isMinimized: () => false,
  isVisible: () => true,
  loadURL: mock(() => Promise.resolve()),
  on: (event: string, listener: (event?: unknown) => void) => {
    windowListeners.set(event, listener);
  },
  once: (event: string, listener: (event?: unknown) => void) => {
    windowListeners.set(event, listener);
  },
  restore: mock(() => undefined),
  show: mock(() => undefined),
  webContents: {
    isDestroyed: () => destroyed,
    on: () => undefined,
    once: (event: string, listener: () => void) => {
      webContentsListeners.set(event, listener);
    },
    send: mock(() => undefined),
  },
};

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    once: (event: string, listener: () => void) => {
      appListeners.set(event, listener);
    },
  },
  shell: { openExternal: () => Promise.resolve() },
}));
mock.module("./app-config", () => ({
  getRendererRootUrl: () => "http://localhost:5173/assistant/",
}));
mock.module("./app-origin.client", () => ({
  isAllowedOrigin: () => true,
  resolveAllowedOrigin: () => new URL("http://localhost:5173"),
}));
mock.module("./ipc.client", () => ({ handle: () => undefined }));
mock.module("./logger", () => ({ default: { error: () => undefined } }));
mock.module("./windows.client", () => ({ createWindow: () => win }));

const { ensureVisible, installMainWindow } = await import("./main-window");

test("hides on close and allows close while quitting", () => {
  installMainWindow();
  const hideClose = mock(() => undefined);

  windowListeners.get("close")?.({ preventDefault: hideClose });

  expect(hideClose).toHaveBeenCalledTimes(1);
  expect(hide).toHaveBeenCalledTimes(1);

  const quitClose = mock(() => undefined);
  appListeners.get("before-quit")?.();
  windowListeners.get("close")?.({ preventDefault: quitClose });

  expect(quitClose).not.toHaveBeenCalled();
  expect(hide).toHaveBeenCalledTimes(1);
});

test("ensureVisible waits for a recreated renderer before resolving", async () => {
  destroyed = true;
  win.show.mockClear();
  win.focus.mockClear();
  let resolved = false;
  const ready = ensureVisible().then(() => {
    resolved = true;
  });
  destroyed = false;

  await Promise.resolve();
  expect(resolved).toBe(false);

  webContentsListeners.get("did-finish-load")?.();
  await Promise.resolve();
  expect(resolved).toBe(false);

  windowListeners.get("ready-to-show")?.();
  await ready;
  expect(resolved).toBe(true);
  expect(win.show).toHaveBeenCalledTimes(1);
  expect(win.focus).toHaveBeenCalledTimes(1);
});
