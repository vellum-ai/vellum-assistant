import { BrowserWindow, app, type WebContents } from "electron";
import { z } from "zod";

import { handle, on } from "./ipc";
import { ensureVisible as ensureMainWindowVisible } from "./main-window";

/**
 * Inbound file-open events — `.vellum` bundle double-clicks in Finder.
 *
 * The OS delivers `open-file` when the user double-clicks a `.vellum`
 * bundle (or drags it onto the Dock icon). This module captures the
 * file path, validates it, and routes it to the renderer via the same
 * buffer/broadcast/subscriber pattern used by `deep-links.ts`.
 *
 * Lifecycle hooks (all required):
 *
 *   - `app.on("will-finish-launching", () => app.on("open-file", ...))`
 *     captures file paths delivered AT launch. Registering in
 *     `whenReady` misses the launching file — same pitfall as deep links.
 *   - `app.on("second-instance")` forwards `.vellum` paths from argv
 *     when a second launch attempt occurs.
 *
 * Buffering: file paths arriving before the renderer subscribes are
 * queued in `pending[]`. The renderer drains via
 * `window.vellum.fileOpen.drain()` once mounted. Live file-open events
 * arriving after drain are broadcast to subscribers; unsubscribed
 * windows still receive broadcasts (same model as deep links).
 */

const VELLUM_EXT_RE = /\.vellum$/i;

const pending: string[] = [];

const subscribers = new Set<WebContents>();

const broadcast = (filePath: string): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("vellum:fileOpen:event", filePath);
  }
};

export const handleFileOpen = (filePath: string): void => {
  if (!VELLUM_EXT_RE.test(filePath)) return;
  if (subscribers.size === 0) pending.push(filePath);
  broadcast(filePath);
  if (app.isReady()) {
    void ensureMainWindowVisible();
  }
};

let installed = false;

export const installFileOpen = (): void => {
  if (installed) return;
  installed = true;

  app.on("will-finish-launching", () => {
    app.on("open-file", (event, filePath) => {
      event.preventDefault();
      handleFileOpen(filePath);
    });
  });

  handle("vellum:fileOpen:drain", z.tuple([]), (_args, event): string[] => {
    if (!subscribers.has(event.sender)) {
      subscribers.add(event.sender);
      event.sender.once("destroyed", () => {
        subscribers.delete(event.sender);
      });
    }
    return pending.splice(0, pending.length);
  });

  on("vellum:fileOpen:subscribe", z.tuple([]), (_args, event) => {
    if (subscribers.has(event.sender)) return;
    subscribers.add(event.sender);
    event.sender.once("destroyed", () => {
      subscribers.delete(event.sender);
    });
  });

  on("vellum:fileOpen:unsubscribe", z.tuple([]), (_args, event) => {
    subscribers.delete(event.sender);
  });
};

export const __resetForTesting = (): void => {
  installed = false;
  subscribers.clear();
  pending.length = 0;
};
