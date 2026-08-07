import { expect, mock, test } from "bun:test";

const appListeners = new Map<string, () => void>();
const windowListeners = new Map<string, (event?: unknown) => void>();
const hide = mock(() => undefined);
const win = {
  focus: () => undefined,
  hide,
  isDestroyed: () => false,
  isFocused: () => true,
  isMinimized: () => false,
  isVisible: () => true,
  loadURL: () => Promise.resolve(),
  on: (event: string, listener: (event?: unknown) => void) => {
    windowListeners.set(event, listener);
  },
  once: (event: string, listener: (event?: unknown) => void) => {
    windowListeners.set(event, listener);
  },
  restore: () => undefined,
  show: () => undefined,
  webContents: { on: () => undefined },
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

const { installMainWindow } = await import("./main-window");

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
