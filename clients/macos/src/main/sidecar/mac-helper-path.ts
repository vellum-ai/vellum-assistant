/**
 * Resolves the on-disk location of the bundled mac-helper.app and its
 * executable. Shared by every consumer that spawns the helper (hotkey/dictation
 * and the host-proxy computer-use executors) so the path logic lives in one
 * place.
 *
 * Why the sidecar: macOS System Settings → Privacy & Security renders the
 * .app folder name (not CFBundleName/CFBundleDisplayName, and not the binary
 * filename) when listing the helper's grants. PR #36120 renamed the
 * executable per env, but kept the .app folder as `vellum-mac-helper.app`,
 * which left the Accessibility entry reading "vellum-mac-helper". The build
 * script now names both the folder AND the binary per env, and writes a
 * sidecar at `<bin>/.vellum-mac-helper.bundle-name` so the runtime can
 * resolve the new folder name without duplicating the env→name mapping in
 * TS. Falls back to the legacy `vellum-mac-helper.app` folder name (and to
 * discovering the bundle by walking the bin directory) when the sidecar is
 * absent — so existing installs that haven't rebuilt yet still work.
 */

import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const SIDECAR_NAME = ".vellum-mac-helper.bundle-name";
const DEFAULT_HELPER_BUNDLE_NAME = "vellum-mac-helper";
const DEFAULT_HELPER_EXECUTABLE = "vellum-mac-helper";

const readSidecarBundleName = (binDir: string): string | null => {
  const sidecarPath = path.join(binDir, SIDECAR_NAME);
  if (!existsSync(sidecarPath)) return null;
  try {
    const value = readFileSync(sidecarPath, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

/**
 * Walks the bin directory to find the .app folder whose Info.plist's
 * CFBundleExecutable matches the executable name. Used as a fallback when
 * the sidecar is missing — gives the path resolution a way to discover a
 * bundle by its binary rather than its folder name.
 */
const resolveHelperBundleNameFromExecutable = (
  binDir: string,
  executableName: string,
): string | null => {
  let entries: import("node:fs").Dirent[];
  try {
    entries = require("node:fs").readdirSync(binDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
    const infoPlist = path.join(binDir, entry.name, "Contents", "Info.plist");
    if (!existsSync(infoPlist)) continue;
    try {
      const match = readFileSync(infoPlist, "utf8").match(
        /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/,
      );
      if (match?.[1]?.trim() === executableName) {
        return entry.name.replace(/\.app$/, "");
      }
    } catch {
      // Skip unreadable plists and keep looking.
    }
  }
  return null;
};

const resolveHelperBundleName = (binDir: string): string => {
  const sidecar = readSidecarBundleName(binDir);
  if (sidecar) return sidecar;

  // Legacy installs (build before this PR) have `bin/vellum-mac-helper.app`
  // with an Info.plist whose CFBundleExecutable is the new per-env name.
  // Walk the bin directory to discover the actual folder name. If there's no
  // .app folder at all, the consumer will surface "mac helper is not
  // available" via the existing missing-bundle guard.
  const discovered = resolveHelperBundleNameFromExecutable(
    binDir,
    DEFAULT_HELPER_EXECUTABLE,
  );
  return discovered ?? DEFAULT_HELPER_BUNDLE_NAME;
};

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

export const getMacHelperAppPath = (): string => {
  const binDir = app.isPackaged
    ? path.join(process.resourcesPath, "bin")
    : path.join(app.getAppPath(), "resources");

  return path.join(binDir, `${resolveHelperBundleName(binDir)}.app`);
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