import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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
 * `ShareMenu` shares files by path, so each share writes its bytes to a
 * throwaway temp dir. Cleanup is deliberately NOT tied to the picker closing:
 * Electron's `popup` callback fires on menu *close* — the moment a service is
 * selected — not when the selected service has finished with the file. An
 * AirDrop transfer, a pasteboard / file-promise reference, or a share extension
 * can still read the file after the menu closes, so deleting there could pull
 * it out from under an in-flight share. Instead we reclaim only *stale* temp
 * dirs — ones old enough (see `SHARE_TMP_STALE_MS`) that no transfer could
 * still be using them — sweeping at startup and before each new share. Bounding
 * to stale dirs also keeps the sweep safe when a second Vellum build is sharing
 * concurrently (it won't touch that build's fresh temp dir), and the OS
 * reclaims `$TMPDIR` regardless.
 */

const SHARE_TMP_PREFIX = "vellum-share-";

// A share temp dir older than this can't belong to an in-flight share — even a
// large AirDrop over a slow link finishes well within an hour — so it's safe to
// reclaim. Anything newer might still be open by the selected service (or by a
// second Vellum build sharing at the same time), so it's left alone.
const SHARE_TMP_STALE_MS = 60 * 60 * 1000;

const ShareFileArgs = z.tuple([z.instanceof(Uint8Array), z.string().min(1)]);

/**
 * Reclaim *stale* share temp dirs — those older than `SHARE_TMP_STALE_MS`.
 * Bounded to old dirs so it never deletes a file this run (or a concurrent
 * build) still has open for an in-flight share. Exported for unit tests.
 */
export const sweepStaleShareDirs = async (): Promise<void> => {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries
      .filter((name) => name.startsWith(SHARE_TMP_PREFIX))
      .map(async (name) => {
        const dir = path.join(root, name);
        try {
          const { mtimeMs } = await stat(dir);
          if (now - mtimeMs >= SHARE_TMP_STALE_MS) {
            await rm(dir, { recursive: true, force: true });
          }
        } catch {
          // Raced with another sweep, or already gone — ignore.
        }
      }),
  );
};

let installed = false;

/** Wire the share IPC handler. Call once from `whenReady`; idempotent. */
export const installShare = (): void => {
  if (installed) return;
  installed = true;

  // Reclaim stale temp files an earlier run left behind (crash / force-quit).
  void sweepStaleShareDirs();

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

      // Opportunistically reclaim old shares so temp usage stays bounded
      // without an unsafe close-time delete. Fire-and-forget — it never blocks
      // the share, and the staleness filter keeps it off the file we're about
      // to write (and off any concurrent share).
      void sweepStaleShareDirs();

      const dir = await mkdtemp(path.join(tmpdir(), SHARE_TMP_PREFIX));
      // `basename` strips any path components the renderer's filename may
      // carry, keeping the write inside the temp dir.
      const filePath = path.join(dir, path.basename(filename));
      await writeFile(filePath, bytes);

      const shareMenu = new ShareMenu({ filePaths: [filePath] });
      // Anchor the sheet to the sender's window. The option is `window`, not
      // `browserWindow`: ShareMenu.popup forwards to Menu.popup, which reads
      // `options.window` (electron@42's types agree — PopupOptions.window). The
      // published share-menu docs say `browserWindow`, but that name is ignored
      // at runtime and would fall back to the focused window.
      shareMenu.popup({
        window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
      });
    },
  );
};
