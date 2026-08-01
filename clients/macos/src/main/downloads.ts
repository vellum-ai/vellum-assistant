import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { app, session } from "electron";

/**
 * Downloads: file a renderer download into `~/Downloads`.
 *
 * The renderer's `saveFile` (clients/web/src/runtime/native-file.ts) downloads
 * the browser way — an `<a download>` click on a blob URL — which Chromium
 * turns into a real download item and Electron surfaces here as
 * `will-download`. Without a handler, Electron falls back to its "original
 * routine" and prompts a Save panel for every download; a desktop app's
 * Download button should just put the file where downloads go, the way the
 * browser build does. So we pick the save path ourselves.
 *
 * Two details this gets right, both of which Chromium normally handles and we
 * inherit responsibility for the moment we call `setSavePath`:
 *
 *   - **Uniquify, don't clobber.** Downloading `report.pdf` twice writes
 *     `report.pdf` then `report (1).pdf` — never silently overwriting a file
 *     the user already has. This is Chromium/Finder's own naming convention.
 *   - **Set the path synchronously.** `DownloadItem.setSavePath` is only
 *     honored while the `will-download` listener is on the stack; deferring it
 *     to a promise hands the item back to the default routine and the Save
 *     panel reappears. That's why the collision check uses `existsSync` rather
 *     than the `node:fs/promises` style used elsewhere in the main process.
 *
 * On completion the Dock's Downloads stack bounces (`app.dock.downloadFinished`
 * — the same NSApplication signal a browser sends), so the download is
 * acknowledged without an in-app toast the renderer would have to own.
 *
 * The share sheet is the *other* intent and lives in `share.ts`: the renderer
 * calls `shareFile` for it, and it never reaches this path.
 *
 * Refs:
 * - https://www.electronjs.org/docs/latest/api/download-item#downloaditemsetsavepathpath
 * - https://www.electronjs.org/docs/latest/api/session#event-will-download
 */

// Chromium gives up de-duplicating a filename long before this; the bound
// exists so a pathological directory can't spin the loop forever. On overflow
// we hand the item back to Electron's default routine (Save panel), which is
// the honest outcome — better than overwriting or failing silently.
const MAX_UNIQUE_ATTEMPTS = 1000;

/**
 * Resolve a non-colliding absolute path for `filename` inside `dir`, following
 * the Finder/Chromium convention: `report.pdf`, `report (1).pdf`, … The
 * existence probe is injected so tests don't need a real filesystem.
 *
 * Returns `null` when no free name was found within `MAX_UNIQUE_ATTEMPTS`.
 * Exported for unit tests.
 */
export const uniqueDownloadPath = (
  dir: string,
  filename: string,
  exists: (candidate: string) => boolean = existsSync,
): string | null => {
  // `basename` strips any path components the download's suggested filename may
  // carry, keeping the write inside the downloads directory.
  const safe = path.basename(filename) || "download";
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || safe;

  for (let n = 0; n < MAX_UNIQUE_ATTEMPTS; n++) {
    const candidate = path.join(dir, n === 0 ? safe : `${stem} (${n})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return null;
};

let installed = false;

/** Wire the download handler. Call once from `whenReady`; idempotent. */
export const installDownloads = (): void => {
  if (installed) return;
  installed = true;

  session.defaultSession.on("will-download", (_event, item) => {
    const dir = app.getPath("downloads");

    // Everything here is best-effort: on any failure we simply don't call
    // `setSavePath`, and Electron's default routine (the Save panel) takes
    // over. A download that asks the user where to put it beats a download
    // that throws out of an event listener.
    try {
      mkdirSync(dir, { recursive: true });
      const savePath = uniqueDownloadPath(dir, item.getFilename());
      if (!savePath) return;
      item.setSavePath(savePath);

      item.once("done", (_doneEvent, state) => {
        // "cancelled" / "interrupted" leave nothing to announce.
        if (state !== "completed") return;
        app.dock?.downloadFinished(savePath);
      });
    } catch {
      // Fall through to Electron's default save routine.
    }
  });
};
