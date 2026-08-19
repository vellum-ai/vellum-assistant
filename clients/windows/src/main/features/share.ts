import { writeFile } from "node:fs/promises";
import path from "node:path";

import { BrowserWindow, dialog } from "electron";
import { z } from "zod";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";

import { handle } from "../ipc.client";

/**
 * Windows `share.shareFile(bytes, filename)` bridge. Windows has no
 * app-invokable equivalent of the macOS share sheet for a classic desktop
 * window, so the committed contract is served by the documented export
 * fallback: a native Save As dialog anchored to the sender's window, writing
 * the bytes directly to the picked destination (no staged temp files).
 * Cancelling resolves without writing, matching the macOS dismissed picker.
 */

const ShareFileArgs = z.tuple([z.instanceof(Uint8Array), z.string().min(1)]);

// Windows-invalid filename characters (plus path separators via basename).
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

export const sanitizeFilename = (filename: string): string => {
  // win32 basename strips both separator styles regardless of host platform.
  const base = path.win32
    .basename(filename)
    .replace(INVALID_FILENAME_CHARS, "_");
  return base.length > 0 ? base : "download";
};

const share: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "share",
  install: () => {
    handle(
      "vellum:share:file",
      ShareFileArgs,
      async ([bytes, filename], event): Promise<void> => {
        const window = BrowserWindow.fromWebContents(event.sender);
        const options = { defaultPath: sanitizeFilename(filename) };
        const { canceled, filePath } = window
          ? await dialog.showSaveDialog(window, options)
          : await dialog.showSaveDialog(options);
        if (canceled || !filePath) {
          return;
        }
        await writeFile(filePath, bytes);
      },
    );
  },
};

export default share;
