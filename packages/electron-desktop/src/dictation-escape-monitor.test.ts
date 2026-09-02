import { beforeEach, expect, mock, test } from "bun:test";

type Listener = () => void;

const appListeners = new Map<string, Listener>();
const shortcutListeners = new Map<string, Listener>();
let focusedWindow: object | null = null;

mock.module("electron", () => ({
  app: {
    on: (event: string, listener: Listener) => appListeners.set(event, listener),
    off: (event: string) => appListeners.delete(event),
  },
  BrowserWindow: class {
    static getFocusedWindow() {
      return focusedWindow;
    }
  },
  globalShortcut: {
    register: (accelerator: string, listener: Listener) => {
      shortcutListeners.set(accelerator, listener);
      return true;
    },
    unregister: (accelerator: string) => shortcutListeners.delete(accelerator),
  },
}));

const { createDictationEscapeMonitor } =
  await import("./dictation-escape-monitor");

beforeEach(() => {
  appListeners.clear();
  shortcutListeners.clear();
  focusedWindow = null;
});

test("Escape cancels only an unfocused active recording", () => {
  const cancel = mock(() => undefined);
  const monitor = createDictationEscapeMonitor({
    cancel,
    log: { info: () => undefined, warn: () => undefined },
  });
  monitor.install();

  monitor.setRecording(true);
  shortcutListeners.get("Escape")?.();
  expect(cancel).toHaveBeenCalledTimes(1);

  focusedWindow = {};
  appListeners.get("browser-window-focus")?.();
  expect(shortcutListeners.has("Escape")).toBe(false);

  focusedWindow = null;
  appListeners.get("browser-window-blur")?.();
  shortcutListeners.get("Escape")?.();
  expect(cancel).toHaveBeenCalledTimes(2);

  monitor.setRecording(false);
  expect(shortcutListeners.has("Escape")).toBe(false);
});

test("a stale shortcut callback rechecks recording and focus", () => {
  const cancel = mock(() => undefined);
  const monitor = createDictationEscapeMonitor({
    cancel,
    log: { info: () => undefined, warn: () => undefined },
  });
  monitor.install();
  monitor.setRecording(true);
  const staleCallback = shortcutListeners.get("Escape")!;

  monitor.setRecording(false);
  staleCallback();
  monitor.setRecording(true);
  focusedWindow = {};
  staleCallback();

  expect(cancel).not.toHaveBeenCalled();
});
