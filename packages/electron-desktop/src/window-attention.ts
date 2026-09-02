import { BrowserWindow, app } from "electron";
import type { WebContents } from "electron";

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
 * `browser-window-blur` plus the main window's own show, hide, minimize,
 * restore, and closed events are edge complete for the three booleans
 * published here. `closed` carries its own weight: a blur can leave renderers
 * holding a visible-but-unfocused window that is then destroyed, and without
 * that edge nothing corrects `visible` until an unrelated transition.
 *
 * Delivery is tracked per `webContents`, not once globally, because the
 * channel is push only and has no request or replay path. Pop-out windows are
 * separate page loads, so renderers routinely appear between attention
 * transitions; a global "same as last time" cache would leave those
 * uninitialized. Each renderer is instead sent the current payload when its
 * page finishes loading (a reload counts as a fresh page), and identical
 * repeats are dropped per recipient so the dedup benefit survives.
 */

const UNATTENDED: WindowAttentionPayload = {
  visible: false,
  focused: false,
  minimized: false,
};

type MainWindowEvent = "show" | "hide" | "minimize" | "restore" | "closed";

const MAIN_WINDOW_EVENTS: MainWindowEvent[] = [
  "show",
  "hide",
  "minimize",
  "restore",
  "closed",
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

export function installWindowAttention(
  deps: WindowAttentionDependencies,
): () => void {
  // Keyed by `webContents` so a renderer that never reaches its `destroyed`
  // event still falls out of the record once Electron drops it.
  const delivered = new WeakMap<WebContents, WindowAttentionPayload>();
  // Subscriptions have to be enumerable for teardown, so this one is a strong
  // Map; every entry removes itself on `destroyed`.
  const untrackers = new Map<WebContents, () => void>();
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
    if (!win) {
      return;
    }
    const emitter: NodeJS.EventEmitter = win;
    for (const event of MAIN_WINDOW_EVENTS) {
      emitter.on(event, publish);
    }
    boundWindow = win;
  }

  function track(contents: WebContents): void {
    if (untrackers.has(contents) || contents.isDestroyed()) {
      return;
    }
    const onLoad = (): void => {
      // A load hands the channel to a document that has heard nothing, so the
      // previous delivery to this `webContents` no longer counts.
      delivered.delete(contents);
      publish();
    };
    const untrack = (): void => {
      untrackers.delete(contents);
      delivered.delete(contents);
      contents.off("did-finish-load", onLoad);
      contents.off("destroyed", untrack);
    };
    contents.on("did-finish-load", onLoad);
    contents.once("destroyed", untrack);
    untrackers.set(contents, untrack);
  }

  function sendTo(
    contents: WebContents,
    payload: WindowAttentionPayload,
  ): void {
    if (contents.isDestroyed()) {
      return;
    }
    const previous = delivered.get(contents);
    if (previous && isSamePayload(previous, payload)) {
      return;
    }
    delivered.set(contents, payload);
    contents.send(WINDOW_ATTENTION, payload);
  }

  function publish(): void {
    const win = deps.currentMainWindow();
    const live = win && !win.isDestroyed() ? win : null;
    if (live !== boundWindow) {
      rebind(live);
    }
    const payload = readAttention(live);
    for (const target of BrowserWindow.getAllWindows()) {
      if (target.isDestroyed()) {
        continue;
      }
      track(target.webContents);
      sendTo(target.webContents, payload);
    }
  }

  function onWindowCreated(_event: unknown, win: BrowserWindow): void {
    track(win.webContents);
  }

  app.on("browser-window-focus", publish);
  app.on("browser-window-blur", publish);
  app.on("browser-window-created", onWindowCreated);

  publish();

  return (): void => {
    app.off("browser-window-focus", publish);
    app.off("browser-window-blur", publish);
    app.off("browser-window-created", onWindowCreated);
    for (const untrack of [...untrackers.values()]) {
      untrack();
    }
    detachWindow();
  };
}
