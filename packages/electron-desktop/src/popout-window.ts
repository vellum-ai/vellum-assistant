import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import { z } from "zod";

import { POPOUT_OPEN } from "@vellumai/ipc-contract";

import type { IpcHandle } from "./ipc";
import { createModuleConfiguration } from "./module-configuration";
import type { CreateWindowOptions } from "./windows";

/**
 * Conversation pop-out windows — independent BrowserWindows showing a single
 * conversation without the sidebar chrome. The user opens one via Cmd+P or
 * right-click → Pop Out; the renderer sends the active conversation ID over
 * IPC and this module creates (or focuses, if one already exists for that
 * conversation) a dedicated window.
 *
 * Design decisions (see LUM-1870):
 *
 * - No `parent` option: making the pop-out a child of the main window pins it
 *   above the parent on macOS and destroys it when the parent closes. Pop-outs
 *   are independent — they outlive the main window on macOS where the app stays
 *   running after the last standard window closes.
 *
 * - State sync via SSE: each window runs its own renderer process with its own
 *   TanStack Query cache and SSE connection. The daemon broadcasts to all
 *   connected clients, so both windows see mutations without custom IPC
 *   invalidation. Auth state is shared via the default session partition.
 *
 * - Window state persisted per conversation: uses the same restore-with-
 *   display-clamp pattern as the main window, keyed under
 *   `thread.<conversationId>`.
 *
 * References:
 * - Electron BrowserWindow: https://www.electronjs.org/docs/latest/api/browser-window
 * - window-all-closed: https://www.electronjs.org/docs/latest/api/app#event-window-all-closed
 */

const POPOUT_DEFAULT_BOUNDS = { width: 720, height: 800 } as const;
const POPOUT_MIN_WIDTH = 500;
const POPOUT_MIN_HEIGHT = 400;

type RestoredBounds = Pick<
  BrowserWindowConstructorOptions,
  "fullscreen" | "height" | "width" | "x" | "y"
> & { maximized?: boolean };

export interface PopoutWindowDependencies {
  createWindow: (options: CreateWindowOptions) => BrowserWindow;
  handle: IpcHandle;
  resolveRoute: (route: string) => string;
  restoreBounds?: (
    key: string,
    defaults: { width: number; height: number },
  ) => RestoredBounds;
  trackWindowState?: (key: string, win: BrowserWindow) => void;
}

const configuration = createModuleConfiguration<PopoutWindowDependencies>(
  "Popout window module",
);
export const configurePopoutWindows = configuration.configure;

/**
 * Registry of open pop-out windows keyed by conversation ID. Lets us focus an
 * existing pop-out instead of stacking duplicates, and clean up on close.
 */
const popouts = new Map<string, BrowserWindow>();

/**
 * Open (or focus) a pop-out window for the given conversation.
 */
export const openPopout = (conversationId: string): void => {
  const { createWindow, resolveRoute, restoreBounds, trackWindowState } =
    configuration.get();
  const existing = popouts.get(conversationId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.show();
    existing.focus();
    return;
  }

  const stateKey = `thread.${conversationId}`;
  // `maximized` is not a BrowserWindow option; apply it once shown.
  const { maximized, ...sizing }: RestoredBounds =
    restoreBounds?.(stateKey, POPOUT_DEFAULT_BOUNDS) ?? POPOUT_DEFAULT_BOUNDS;

  const win = createWindow({
    browserWindow: {
      ...sizing,
      minWidth: POPOUT_MIN_WIDTH,
      minHeight: POPOUT_MIN_HEIGHT,
      title: "Vellum",
      show: false,
    },
    // A pop-out thread can own a live-voice session too, which is why the
    // session pill has a standalone variant for these windows, so it needs
    // the main window's exemption for the same reason.
    backgroundThrottling: false,
    navigation: {
      installGuard: (w) => {
        // Block top-level navigation (prevents navigating away from the pop-out
        // route via bare <a href>, dropped URLs, or location writes) but do NOT
        // override setWindowOpenHandler — the global handler in index.ts
        // forwards target=_blank links to shell.openExternal and allows OAuth
        // popups, which chat messages and connect flows depend on.
        w.webContents.on("will-navigate", (event) => {
          event.preventDefault();
        });
      },
    },
  });

  trackWindowState?.(stateKey, win);
  popouts.set(conversationId, win);

  win.once("ready-to-show", () => {
    if (maximized) {
      win.maximize();
    }
    win.show();
    win.focus();
  });

  win.on("closed", () => {
    popouts.delete(conversationId);
  });

  // External link handling: the global web-contents-created handler in index.ts
  // installs setWindowOpenHandler on every WebContents, forwarding target=_blank
  // links to shell.openExternal and allowing OAuth popups. Our custom
  // installGuard intentionally does NOT override it.

  void win.loadURL(
    resolveRoute(`/conversations/${conversationId}?popout=1`),
  );
};

/**
 * Returns the set of conversation IDs that currently have open pop-out windows.
 * Used by tests; not exposed to the renderer.
 */
export const openPopoutIds = (): ReadonlySet<string> =>
  new Set(popouts.keys());

let installed = false;

export const installPopoutWindows = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  const { handle } = configuration.get();

  handle(
    POPOUT_OPEN,
    z.tuple([z.string()]),
    ([conversationId]) => {
      openPopout(conversationId);
    },
  );
};
