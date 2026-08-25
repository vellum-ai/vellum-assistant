import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { app, session, shell, type WebContents } from "electron";
import { z } from "zod";

import {
  DOWNLOADS_DONE_EVENT,
  DOWNLOADS_REVEAL,
  type DownloadDoneEvent,
} from "@vellumai/ipc-contract";

import type { IpcHandle } from "./ipc";

/**
 * Downloads: files a renderer download into the host's Downloads folder and
 * reports the outcome back to the window that started it.
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
 * Outcome reporting: each terminal `done` state is pushed to the originating
 * window as a `DownloadDoneEvent` so the renderer can confirm the save (and
 * offer a file-manager reveal) or surface the failure. This holds on the
 * Save-panel fallback too (the listener is registered before path selection,
 * and reads the item's final path at `done` time). A cancelled download is
 * not pushed: cancellation, including dismissing the Save panel, is the
 * user's own action and needs no announcement.
 * On macOS the Dock's Downloads stack additionally bounces
 * (`app.dock.downloadFinished`, the same NSApplication signal a browser
 * sends); `app.dock` is absent on Windows, where the renderer toast is the
 * only cue.
 *
 * Reveal: the completed event carries an opaque `id`, not the saved path. The
 * renderer hands the id back over `DOWNLOADS_REVEAL` and main resolves it from
 * `revealable`, so the channel can only ever reveal a file this module saved
 * in this app session; an unknown id is ignored.
 *
 * The share sheet is the other intent and lives in each shell's share module:
 * the renderer calls `shareFile` for it, and it never reaches this path.
 *
 * Refs:
 * - https://www.electronjs.org/docs/latest/api/download-item#downloaditemsetsavepathpath
 * - https://www.electronjs.org/docs/latest/api/session#event-will-download
 * - https://www.electronjs.org/docs/latest/api/shell#shellshowiteminfolderfullpath
 */

// Chromium gives up de-duplicating a filename long before this; the bound
// exists so a pathological directory can't spin the loop forever. On overflow
// the item goes back to Electron's default routine (Save panel), which is the
// honest outcome: better than overwriting or failing silently.
const MAX_UNIQUE_ATTEMPTS = 1000;

// Completed saves outlive their toast only briefly; the cap just keeps a
// long-lived session from accumulating paths forever.
const MAX_REVEALABLE = 50;

// Save paths handed to in-flight downloads, held from `will-download` until
// `done` so a concurrent download of the same filename can't select the same
// destination. See the "Reserve the name" note above. Keys are lowercased:
// both shells target case-insensitive default filesystems (APFS, NTFS),
// where `existsSync` already matches either case, so the in-flight set must
// too or `Report.pdf` and `report.pdf` would race one destination. On a
// case-sensitive volume this over-reserves, which costs a " (1)" suffix,
// never a clobber.
const reserved = new Set<string>();

// Opaque id -> saved path for completed downloads, the only paths
// `DOWNLOADS_REVEAL` can reach. Insertion-ordered, evicted oldest-first.
const revealable = new Map<string, string>();

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

const RevealArgs = z.tuple([z.string().min(1)]);

const sendDone = (webContents: WebContents, event: DownloadDoneEvent): void => {
  if (webContents.isDestroyed()) {
    return;
  }
  webContents.send(DOWNLOADS_DONE_EVENT, event);
};

let installed = false;

/**
 * Wire the download handler and the reveal channel. Call once from
 * `whenReady`; idempotent. `handle` is the shell's origin-validating IPC
 * registrar (`createIpcRegistrar`), so reveal requests from anything but the
 * app renderer are rejected before dispatch.
 */
export const installDownloads = ({ handle }: { handle: IpcHandle }): void => {
  if (installed) {
    return;
  }
  installed = true;

  handle(DOWNLOADS_REVEAL, RevealArgs, ([id]) => {
    const savedPath = revealable.get(id);
    if (savedPath) {
      shell.showItemInFolder(savedPath);
    }
  });

  session.defaultSession.on("will-download", (_event, item, webContents) => {
    const dir = app.getPath("downloads");

    // Outcome reporting is registered before path selection so it covers the
    // Save-panel fallback too: a download whose destination Electron's default
    // routine asked for still reports. `item.getSavePath()` is read at `done`
    // time because only then is it final on the fallback path.
    let reservedPath: string | null = null;
    item.once("done", (_doneEvent, state) => {
      // Released on every terminal state: a cancelled or interrupted
      // download leaves the name free for the next one.
      if (reservedPath !== null) {
        reserved.delete(reservedPath.toLowerCase());
      }
      const savePath = item.getSavePath();
      // Cancelled covers dismissing the Save panel, where no destination was
      // ever chosen; either way cancellation is the user's own action and
      // needs no announcement.
      if (state === "cancelled" || !savePath) {
        return;
      }
      // The name on disk is the uniquified (or panel-chosen) one, which is
      // what the user has to look for, so the report carries it rather than
      // the originally suggested filename.
      const filename = path.basename(savePath);
      if (state !== "completed") {
        sendDone(webContents, { filename, state: "interrupted" });
        return;
      }
      const id = randomUUID();
      revealable.set(id, savePath);
      // One insert per completion, so one oldest-first eviction holds the cap.
      const oldest = revealable.keys().next().value;
      if (revealable.size > MAX_REVEALABLE && oldest !== undefined) {
        revealable.delete(oldest);
      }
      app.dock?.downloadFinished(savePath);
      sendDone(webContents, { id, filename, state });
    });

    // Path selection is best-effort: on any failure it skips `setSavePath`
    // and Electron's default routine (the Save panel) takes over. A download
    // that asks the user where to put it beats a download that throws out of
    // an event listener.
    try {
      mkdirSync(dir, { recursive: true });
      const savePath = uniqueDownloadPath(
        dir,
        item.getFilename(),
        (candidate) =>
          reserved.has(candidate.toLowerCase()) || existsSync(candidate),
      );
      if (!savePath) {
        return;
      }
      item.setSavePath(savePath);
      reserved.add(savePath.toLowerCase());
      reservedPath = savePath;
    } catch {
      // Fall through to Electron's default save routine.
    }
  });
};

// Test seam: clears the in-flight reservations and the reveal registry so a
// test starts from a clean slate. Production code never calls this.
export const __resetForTesting = (): void => {
  reserved.clear();
  revealable.clear();
};
