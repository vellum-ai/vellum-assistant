import { beforeEach, expect, mock, test } from "bun:test";

const appListeners = new Map<string, () => void>();
mock.module("electron", () => ({
  app: {
    on: (event: string, listener: () => void) =>
      appListeners.set(event, listener),
  },
}));

let badgeHandler: ((args: [number]) => void) | null = null;
mock.module("./ipc.client", () => ({
  on: (
    _channel: string,
    _schema: unknown,
    listener: (args: [number]) => void,
  ) => {
    badgeHandler = listener;
  },
}));

let status = "idle";
let statusListener: (() => void) | null = null;
const unsubscribe = mock(() => undefined);
mock.module("@vellumai/electron-desktop/status", () => ({
  getStatus: () => status,
  onStatusChange: (listener: () => void) => {
    statusListener = listener;
    return unsubscribe;
  },
}));

const setOverlayIcon = mock(() => undefined);
const setProgressBar = mock(() => undefined);
const win = {
  isDestroyed: () => false,
  setOverlayIcon,
  setProgressBar,
};

const { installTaskbar } = await import("./taskbar");

beforeEach(() => {
  appListeners.clear();
  badgeHandler = null;
  status = "idle";
  statusListener = null;
  setOverlayIcon.mockClear();
  setProgressBar.mockClear();
  unsubscribe.mockClear();
});

test("publishes unread counts and clears the taskbar overlay", () => {
  const overlayIcon = { id: "tray" } as never;
  installTaskbar({ getWindow: () => win as never, overlayIcon });

  badgeHandler?.([3.8]);
  expect(setOverlayIcon).toHaveBeenLastCalledWith(
    overlayIcon,
    "3 unread conversations",
  );

  badgeHandler?.([-2]);
  expect(setOverlayIcon).toHaveBeenLastCalledWith(null, "");
});

test("maps live assistant status to taskbar progress", () => {
  installTaskbar({ getWindow: () => win as never, overlayIcon: {} as never });

  status = "thinking";
  statusListener?.();
  expect(setProgressBar).toHaveBeenLastCalledWith(2, {
    mode: "indeterminate",
  });

  status = "disconnected";
  statusListener?.();
  expect(setProgressBar).toHaveBeenLastCalledWith(1, { mode: "paused" });
});

test("clears attention state and unsubscribes before quit", () => {
  installTaskbar({ getWindow: () => win as never, overlayIcon: {} as never });
  badgeHandler?.([4]);

  appListeners.get("before-quit")?.();

  expect(setOverlayIcon).toHaveBeenLastCalledWith(null, "");
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
