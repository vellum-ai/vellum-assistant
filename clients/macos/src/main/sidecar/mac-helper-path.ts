/**
 * Resolves the on-disk location of the bundled `vellum-mac-helper.app` and its
 * executable. Shared by every consumer that spawns the helper (hotkey/dictation
 * and the host-proxy computer-use executors) so the path logic lives in one
 * place.
 */

import { app } from "electron";
import path from "node:path";

export const getMacHelperAppPath = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bin", "vellum-mac-helper.app");
  }
  return path.join(app.getAppPath(), "resources", "vellum-mac-helper.app");
};

export const getMacHelperPath = (): string =>
  path.join(getMacHelperAppPath(), "Contents", "MacOS", "vellum-mac-helper");
