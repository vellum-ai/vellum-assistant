import { BrowserWindow, app } from "electron";

import { WINDOW_ATTENTION } from "@vellumai/ipc-contract";
import type { WindowAttentionPayload } from "@vellumai/ipc-contract";

/**
 * Authoritative main-window state, published from main to every renderer.
 *
 * Every Vellum window sets `backgroundThrottling: false`, which also disables
 * the Page Visibility API. A renderer therefore reads `document.visibilityState`
 * as "visible" forever and never receives `visibilitychange`, so it cannot tell
 * that it is off screen. Main can, through `BrowserWindow` state plus the app's
 * focus and blur events.
 *
 * The publisher is event driven, never polled: `browser-window-focus` /
 * `browser-window-blur` plus the main window's own show, hide, minimize, and
 * restore events are edge complete for the three booleans published here.
 */

const UNATTENDED: WindowAttentionPayload = {
  visible: false,
  focused: false,
  minimized: false,
};

type MainWindowEvent = "show" | "hide" | "minimize" | "restore";

const MAIN_WINDOW_EVENTS: MainWindowEvent[] = [
  "show",
  "hide",
  "minimize",
  "restore",
];

export interface WindowAttentionDependencies {
  currentMainWindow: () => BrowserWindow | null;
}

const readAttention = (win: BrowserWindow | null): WindowAttentionPayload => {
  if (!win || win.isDestroyed()) {
    return UNATTENDED;
  }
  return {
    visible: win.isVisible(),
    focused: win.isFocused(),
    minimized: win.isMinimized(),
  };
};

const isSamePayload = (
  a: WindowAttentionPayload,
  b: WindowAttentionPayload,
): boolean => {
  return (
    a.visible === b.visible &&
    a.focused === b.focused &&
    a.minimized === b.minimized
  );
};

const broadcast = (payload: WindowAttentionPayload): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    win.webContents.send(WINDOW_ATTENTION, payload);
  }
};

export function installWindowAttention(
  deps: WindowAttentionDependencies,
): () => void {
  let lastPayload: WindowAttentionPayload | null = null;
  let boundWindow: BrowserWindow | null = null;

  function detachWindow(): void {
    if (boundWindow && !boundWindow.isDestroyed()) {
      const emitter: NodeJS.EventEmitter = boundWindow;
      for (const event of MAIN_WINDOW_EVENTS) {
        emitter.off(event, publish);
      }
    }
    boundWindow = null;
  }

  // The accessor can return null before the shell builds its window, and a
  // fresh window after one is rebuilt, so binding is resolved on every edge.
  function rebind(win: BrowserWindow | null): void {
    detachWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    const emitter: NodeJS.EventEmitter = win;
    for (const event of MAIN_WINDOW_EVENTS) {
      emitter.on(event, publish);
    }
    boundWindow = win;
  }

  function publish(): void {
    const win = deps.currentMainWindow();
    if (win !== boundWindow) {
      rebind(win);
    }
    const payload = readAttention(win);
    if (lastPayload && isSamePayload(lastPayload, payload)) {
      return;
    }
    lastPayload = payload;
    broadcast(payload);
  }

  app.on("browser-window-focus", publish);
  app.on("browser-window-blur", publish);

  publish();

  return (): void => {
    app.off("browser-window-focus", publish);
    app.off("browser-window-blur", publish);
    detachWindow();
  };
}
