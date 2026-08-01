import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { app, session } from "electron";

/**
 * Downloads: files a renderer download into `~/Downloads`.
 *
 * The renderer's `saveFile` (clients/web/src/runtime/native-file.ts) downloads
 * the browser way, an `<a download>` click on a blob URL, which Chromium turns
 * into a real download item and Electron surfaces here as `will-download`.
 * Absent a handler, Electron falls back to its "original routine" and prompts a
 * Save panel for every download; a desktop app's Download button should just
 * put the file where downloads go, the way the browser build does. So this
 * picks the save path itself.
 *
 * Three details this owns the moment it calls `setSavePath`, all of which
 * Chromium otherwise handles:
 *
 *   - **Uniquify, don't clobber.** Downloading `report.pdf` twice writes
 *     `report.pdf` then `report (1).pdf`, never silently overwriting a file the
 *     user already has. This is Chromium/Finder's own naming convention.
 *   - **Reserve the name for the whole transfer.** A download's file does not
 *     exist on disk at `will-download` time (Chromium creates it as bytes
 *     arrive), so `existsSync` alone cannot see a transfer that is already
 *     heading for that name. Two same-named downloads started close together
 *     (a double-clicked button) would both pick the same path and race for one
 *     destination. `reserved` holds each chosen path until that item's `done`
 *     event, so the second download picks the next free name.
 *   - **Set the path synchronously.** `DownloadItem.setSavePath` is only
 *     honored while the `will-download` listener is on the stack; deferring it
 *     to a promise hands the item back to the default routine and the Save
 *     panel appears. Hence the synchronous `existsSync` collision check rather
 *     than the `node:fs/promises` style used elsewhere in the main process.
 *
 * On completion the Dock's Downloads stack bounces
 * (`app.dock.downloadFinished`, the same NSApplication signal a browser sends),
 * so the download is acknowledged without an in-app toast the renderer would
 * have to own.
 *
 * The share sheet is the other intent and lives in `share.ts`: the renderer
 * calls `shareFile` for it, and it never reaches this path.
 *
 * Refs:
 * - https://www.electronjs.org/docs/latest/api/download-item#downloaditemsetsavepathpath
 * - https://www.electronjs.org/docs/latest/api/session#event-will-download
 */

// Chromium gives up de-duplicating a filename long before this; the bound
// exists so a pathological directory can't spin the loop forever. On overflow
// the item goes back to Electron's default routine (Save panel), which is the
// honest outcome: better than overwriting or failing silently.
const MAX_UNIQUE_ATTEMPTS = 1000;

// Save paths handed to in-flight downloads, held from `will-download` until
// `done` so a concurrent download of the same filename can't select the same
// destination. See the "Reserve the name" note above.
const reserved = new Set<string>();

/**
 * Resolve a non-colliding absolute path for `filename` inside `dir`, following
 * the Finder/Chromium convention: `report.pdf`, `report (1).pdf`, and so on.
 * `isTaken` decides whether a candidate is unavailable, so the caller supplies
 * both halves of "unavailable" (on disk, or reserved by an in-flight download)
 * and tests can run without a filesystem.
 *
 * Returns `null` when no free name was found within `MAX_UNIQUE_ATTEMPTS`.
 * Exported for unit tests.
 */
export const uniqueDownloadPath = (
  dir: string,
  filename: string,
  isTaken: (candidate: string) => boolean,
): string | null => {
  // `basename` strips any path components the download's suggested filename may
  // carry, keeping the write inside the downloads directory.
  const safe = path.basename(filename) || "download";
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || safe;

  for (let n = 0; n < MAX_UNIQUE_ATTEMPTS; n++) {
    const candidate = path.join(dir, n === 0 ? safe : `${stem} (${n})${ext}`);
    if (!isTaken(candidate)) {
      return candidate;
    }
  }
  return null;
};

let installed = false;

/** Wire the download handler. Call once from `whenReady`; idempotent. */
export const installDownloads = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  session.defaultSession.on("will-download", (_event, item) => {
    const dir = app.getPath("downloads");

    // Everything here is best-effort: on any failure the handler skips
    // `setSavePath` and Electron's default routine (the Save panel) takes over.
    // A download that asks the user where to put it beats a download that
    // throws out of an event listener.
    try {
      mkdirSync(dir, { recursive: true });
      const savePath = uniqueDownloadPath(
        dir,
        item.getFilename(),
        (candidate) => reserved.has(candidate) || existsSync(candidate),
      );
      if (!savePath) {
        return;
      }
      item.setSavePath(savePath);
      reserved.add(savePath);

      item.once("done", (_doneEvent, state) => {
        // Released on every terminal state: a cancelled or interrupted
        // download leaves the name free for the next one.
        reserved.delete(savePath);
        if (state !== "completed") {
          return;
        }
        app.dock?.downloadFinished(savePath);
      });
    } catch {
      // Fall through to Electron's default save routine.
    }
  });
};

// Test seam: clears the in-flight reservations so a test starts from a clean
// slate. Production code never calls this.
export const __resetForTesting = (): void => {
  reserved.clear();
};
