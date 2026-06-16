import { app } from "electron";

import log from "./logger";

/**
 * Relocate the app into /Applications on first launch when it is running from
 * somewhere else (a mounted DMG, ~/Downloads, etc.), then relaunch from the
 * new location.
 *
 * This is the "double-click to install" half of the DMG installer flow: the
 * DMG ships a single app icon under "Install Vellum / Double click the icon
 * below" with no Applications alias, and the app installs itself here instead
 * of asking the user to drag it. It also resolves macOS app translocation —
 * an app launched from a quarantined DMG runs from a randomized read-only path
 * until it is moved into /Applications via the Finder, and
 * `moveToApplicationsFolder()` performs that move programmatically.
 *
 * The move is silent (no confirmation dialog) to match a lightweight installer
 * feel. It is a no-op when:
 *  - running an unpackaged dev build, or
 *  - already in /Applications.
 *
 * Returns `true` if the app is being relocated — the caller must bail out of
 * further initialization because the process is about to quit and relaunch.
 * Returns `false` if startup should continue from the current location.
 *
 * @see https://www.electronjs.org/docs/latest/api/app#appmovetoapplicationsfolderoptions-macos
 */
export function relocateToApplicationsFolder(): boolean {
  if (!app.isPackaged) return false;
  if (app.isInApplicationsFolder()) return false;

  try {
    return app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => {
        if (conflictType === "existsAndRunning") {
          // Another copy is already installed and running. Leave it be and
          // keep running from the current location for this session rather
          // than nagging — the user clearly already has Vellum installed.
          log.info(
            "[move-to-applications] /Applications copy already running; skipping move",
          );
          return false;
        }
        // "exists" — a stale copy is present but not running; overwrite it.
        return true;
      },
    });
  } catch (err) {
    log.error("[move-to-applications] moveToApplicationsFolder failed:", err);
    return false;
  }
}
