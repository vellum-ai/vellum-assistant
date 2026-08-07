import { expect, mock, test } from "bun:test";

type Listener = () => void;

const windowListeners = new Map<string, Listener>();
const webContentsListeners = new Map<string, Listener>();
let destroyed = false;

const win = {
  webContents: {
    isDestroyed: () => destroyed,
    on: () => undefined,
    once: (event: string, listener: Listener) => {
      webContentsListeners.set(event, listener);
    },
    send: mock(() => undefined),
  },
  focus: mock(() => undefined),
  isDestroyed: () => destroyed,
  isMinimized: () => false,
  loadURL: mock(() => Promise.resolve()),
  on: (event: string, listener: Listener) => {
    windowListeners.set(event, listener);
  },
  once: (event: string, listener: Listener) => {
    windowListeners.set(event, listener);
  },
  restore: mock(() => undefined),
  show: mock(() => undefined),
};

mock.module("electron", () => ({
  app: { isPackaged: false },
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

const { ensureVisible } = await import("./main-window");

test("ensureVisible waits for a recreated renderer before resolving", async () => {
  let resolved = false;
  const ready = ensureVisible().then(() => {
    resolved = true;
  });

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
