import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BrowserWindow, ShareMenu } from "electron";
import { z } from "zod";

import { handle } from "./ipc";

/**
 * macOS Share Sheet bridge.
 *
 * The renderer's cross-platform `saveFile` (clients/web/src/runtime/
 * native-file.ts) routes here on the Electron host: it hands over the file
 * bytes + name, and this presents the native `NSSharingServicePicker`
 * (Messages, Mail, AirDrop, Slack, Save to Files, …) — the same "export from
 * the app" UX the iOS build gets from `@capacitor/share`, and the one thing a
 * plain browser download can't offer.
 *
 * `ShareMenu` shares files by path, so the bytes are written to a throwaway
 * temp dir first and removed once the sheet closes. Share targets copy the
 * file when picked (AirDrop keeps its own reference), so tearing the temp dir
 * down on close is safe — mirroring the iOS path's post-dismiss cleanup.
 */

const ShareFileArgs = z.tuple([z.instanceof(Uint8Array), z.string().min(1)]);

let installed = false;

/** Wire the share IPC handler. Call once from `whenReady`; idempotent. */
export const installShare = (): void => {
  if (installed) return;
  installed = true;

  handle(
    "vellum:share:file",
    ShareFileArgs,
    async ([bytes, filename], event): Promise<void> => {
      // `ShareMenu` wraps NSSharingServicePicker, so it is macOS-only. The
      // shell only ships on macOS, but guard so a non-darwin build fails
      // loudly instead of throwing an opaque constructor error.
      if (process.platform !== "darwin") {
        throw new Error("Share sheet is only available on macOS");
      }

      const dir = await mkdtemp(path.join(tmpdir(), "vellum-share-"));
      // `basename` strips any path components the renderer's filename may
      // carry, keeping the write inside the temp dir.
      const filePath = path.join(dir, path.basename(filename));
      await writeFile(filePath, bytes);

      const shareMenu = new ShareMenu({ filePaths: [filePath] });
      shareMenu.popup({
        window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
        callback: () => void rm(dir, { recursive: true, force: true }),
      });
    },
  );
};
