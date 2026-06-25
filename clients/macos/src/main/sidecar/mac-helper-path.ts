/**
 * Resolves the on-disk location of the bundled `vellum-mac-helper.app` and its
 * executable. Shared by every consumer that spawns the helper (hotkey/dictation
 * and the host-proxy computer-use executors) so the path logic lives in one
 * place.
 */

import { app } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";

export const getMacHelperAppPath = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bin", "vellum-mac-helper.app");
  }
  return path.join(app.getAppPath(), "resources", "vellum-mac-helper.app");
};

// build-mac-helper.sh names the executable per environment ("Vellum Helper",
// "Vellum Helper Dev", …) so the macOS Privacy & Security list shows a friendly,
// env-specific name. Read the bundle's own CFBundleExecutable rather than
// hard-coding it, so this stays correct regardless of how the build named it.
const DEFAULT_HELPER_EXECUTABLE = "vellum-mac-helper";

const resolveHelperExecutableName = (appPath: string): string => {
  try {
    const infoPlist = readFileSync(
      path.join(appPath, "Contents", "Info.plist"),
      "utf8",
    );
    const match = infoPlist.match(
      /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/,
    );
    return match?.[1]?.trim() || DEFAULT_HELPER_EXECUTABLE;
  } catch {
    return DEFAULT_HELPER_EXECUTABLE;
  }
};

export const getMacHelperPath = (): string => {
  const appPath = getMacHelperAppPath();
  return path.join(
    appPath,
    "Contents",
    "MacOS",
    resolveHelperExecutableName(appPath),
  );
};
