import { app, dialog } from "electron";
import Store from "electron-store";

import log from "./logger";

interface LifecycleStore {
  moveToApplicationsDeclined?: boolean;
}

let store: Store<LifecycleStore> | null = null;

const getStore = (): Store<LifecycleStore> => {
  if (!store) {
    store = new Store<LifecycleStore>({ name: "app-lifecycle" });
  }
  return store;
};

/**
 * Offer to move the app to /Applications when running from a non-standard
 * location (e.g. a mounted DMG or ~/Downloads). Uses Electron's built-in
 * `app.moveToApplicationsFolder()` which copies the .app, relaunches from
 * /Applications, and terminates the current process.
 *
 * No-op when:
 *  - Running an unpackaged dev build
 *  - Already in /Applications
 *  - The user previously declined the prompt
 *
 * Returns `true` if the app is being moved (caller should bail out of
 * further initialization), `false` if startup should continue normally.
 *
 * @see https://www.electronjs.org/docs/latest/api/app#appmoveToApplicationsFolderoptions-macos
 */
export async function offerMoveToApplications(): Promise<boolean> {
  if (!app.isPackaged) return false;
  if (app.isInApplicationsFolder()) return false;
  if (getStore().get("moveToApplicationsDeclined")) return false;

  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
    message: "Move to Applications folder?",
    detail:
      "Vellum works best when installed in the Applications folder. " +
      "Would you like to move it there now?",
  });

  if (response === 1) {
    getStore().set("moveToApplicationsDeclined", true);
    return false;
  }

  try {
    return app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => {
        if (conflictType === "existsAndRunning") {
          dialog.showErrorBox(
            "Cannot move Vellum",
            "Another copy of Vellum is already running from the Applications " +
              "folder. Please quit it first, then try again.",
          );
          return false;
        }
        // "exists" — overwrite the stale copy
        return true;
      },
    });
  } catch (err) {
    log.error("[move-to-applications] moveToApplicationsFolder failed:", err);
    return false;
  }
}
