import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { app, BrowserWindow, ShareMenu } from "electron";
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
 * `ShareMenu` shares files by path, so each share writes its bytes to a
 * throwaway temp dir. Cleanup is deliberately NOT tied to the picker closing:
 * Electron's `popup` callback fires on menu *close* — the moment a service is
 * selected — not when the selected service has finished with the file. An
 * AirDrop transfer, a pasteboard / file-promise reference, or a share extension
 * can still read the file after the menu closes, so deleting there could pull
 * it out from under an in-flight share. Instead the temp dirs are swept when no
 * share can be in flight — at startup and best-effort on quit — and the OS
 * reclaims `$TMPDIR` regardless.
 */

const SHARE_TMP_PREFIX = "vellum-share-";

const ShareFileArgs = z.tuple([z.instanceof(Uint8Array), z.string().min(1)]);

/**
 * Remove leftover share temp dirs. Safe only when no share is in flight — call
 * at startup (before any file is shared) or on quit (the app is closing).
 * Exported for unit tests.
 */
export const sweepShareDirs = async (): Promise<void> => {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith(SHARE_TMP_PREFIX))
      .map((name) =>
        rm(path.join(root, name), { recursive: true, force: true }).catch(
          () => {},
        ),
      ),
  );
};

let installed = false;

/** Wire the share IPC handler. Call once from `whenReady`; idempotent. */
export const installShare = (): void => {
  if (installed) return;
  installed = true;

  // Reclaim temp files an earlier run left behind (crash / force-quit), and
  // clean this run's files on quit. Neither runs while a share is in flight.
  void sweepShareDirs();
  app.on("before-quit", () => void sweepShareDirs());

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

      const dir = await mkdtemp(path.join(tmpdir(), SHARE_TMP_PREFIX));
      // `basename` strips any path components the renderer's filename may
      // carry, keeping the write inside the temp dir.
      const filePath = path.join(dir, path.basename(filename));
      await writeFile(filePath, bytes);

      const shareMenu = new ShareMenu({ filePaths: [filePath] });
      shareMenu.popup({
        window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
      });
    },
  );
};
