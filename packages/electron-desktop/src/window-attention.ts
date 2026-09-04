import { BrowserWindow, app } from "electron";
import type { WebContents } from "electron";

import { WINDOW_ATTENTION } from "@vellumai/ipc-contract";
import type { WindowAttentionPayload } from "@vellumai/ipc-contract";

/**
 * Authoritative window state, published from main to the renderer that each
 * window owns.
 *
 * Every Vellum window sets `backgroundThrottling: false`, which also disables
 * the Page Visibility API. A renderer therefore reads `document.visibilityState`
 * as "visible" forever and never receives `visibilitychange`, so it cannot tell
 * that it is off screen. Main can, through `BrowserWindow` state plus the app's
 * focus and blur events.
 *
 * Every renderer hears about its own window and no other. A conversation
 * pop-out is an independent window with its own visibility, and the consumers
 * reading this signal act on it: they stop the camera, drop live capture
 * consent, and tear down the SSE stream. Handing a pop-out the main window's
 * state would disconnect the conversation the user is looking at the moment
 * the main window is minimized behind it.
 *
 * The publisher is event driven, never polled: `browser-window-focus` /
 * `browser-window-blur` plus each window's own show, hide, minimize, restore,
 * and closed events are edge complete for the three booleans published here.
 * `closed` carries its own weight: the window that inherits focus from one
 * being destroyed is not guaranteed an app-level focus event, and without that
 * edge nothing corrects `focused` until an unrelated transition.
 *
 * Delivery is tracked per `webContents`, not once globally, because the
 * channel is push only and main answers no requests on it. Pop-out windows are
 * separate page loads, so renderers routinely appear between attention
 * transitions; a global "same as last time" cache would leave those
 * uninitialized. Each renderer is instead sent its window's payload when its
 * page finishes loading (a reload counts as a fresh page), and identical
 * repeats are dropped per recipient so the dedup benefit survives. The preload
 * caches that payload and replays it to callbacks that register later, so the
 * per-page send reaches renderer subscribers whenever they appear.
 */

type WindowEvent = "show" | "hide" | "minimize" | "restore";

const WINDOW_EVENTS: WindowEvent[] = ["show", "hide", "minimize", "restore"];

const readAttention = (win: BrowserWindow): WindowAttentionPayload => {
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

export function installWindowAttention(): () => void {
  // Keyed by `webContents` so a renderer that never reaches its `destroyed`
  // event still falls out of the record once Electron drops it.
  const delivered = new WeakMap<WebContents, WindowAttentionPayload>();
  // Subscriptions have to be enumerable for teardown, so this one is a strong
  // Map; every entry removes itself when its window closes or its renderer is
  // destroyed.
  const untrackers = new Map<WebContents, () => void>();

  function track(win: BrowserWindow): void {
    if (win.isDestroyed()) {
      return;
    }
    const contents = win.webContents;
    if (untrackers.has(contents) || contents.isDestroyed()) {
      return;
    }

    // Each subscription registers its own remover, so a window that closes
    // takes every listener it owns with it rather than waiting for teardown.
    // Dropping a listener never reaches the native handle, so a remover still
    // runs on a window Electron has already destroyed.
    const removers: Array<() => void> = [];
    const untrack = (): void => {
      untrackers.delete(contents);
      delivered.delete(contents);
      for (const remove of removers) {
        remove();
      }
      removers.length = 0;
    };
    const onLoad = (): void => {
      // A load hands the channel to a document that has heard nothing, so the
      // previous delivery to this `webContents` no longer counts.
      delivered.delete(contents);
      publish();
    };
    const onClosed = (): void => {
      untrack();
      publish();
    };

    const emitter: NodeJS.EventEmitter = win;
    for (const event of WINDOW_EVENTS) {
      emitter.on(event, publish);
      removers.push(() => {
        emitter.off(event, publish);
      });
    }
    emitter.on("closed", onClosed);
    removers.push(() => {
      emitter.off("closed", onClosed);
    });
    contents.on("did-finish-load", onLoad);
    removers.push(() => {
      contents.off("did-finish-load", onLoad);
    });
    contents.once("destroyed", untrack);
    removers.push(() => {
      contents.off("destroyed", untrack);
    });

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
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) {
        continue;
      }
      track(win);
      sendTo(win.webContents, readAttention(win));
    }
  }

  function onWindowCreated(_event: unknown, win: BrowserWindow): void {
    track(win);
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
  };
}
