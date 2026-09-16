import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { isPlainObject } from "../util/object.js";

export function shouldRestoreDesktopChromeSession(profileDir: string): boolean {
  return (
    readProfileMetadata(chromePreferencesPath(profileDir))?.exit_type ===
    "Crashed"
  );
}

/** Configure Chrome's own title bar before the browser or dock starts. */
export function configureDesktopChromeFrame(profileDir: string): void {
  const path = chromePreferencesPath(profileDir);
  let preferences: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(value)) {
      throw new Error("Desktop Chrome preferences must be a JSON object");
    }
    preferences = value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  const browser = preferences.browser ?? {};
  if (!isPlainObject(browser)) {
    throw new Error("Desktop Chrome browser preferences must be a JSON object");
  }
  if (browser.custom_chrome_frame === true) {
    return;
  }
  preferences.browser = { ...browser, custom_chrome_frame: true };
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(join(directory, ".vellum-frame-"));
  try {
    const temporaryPath = join(staging, "Preferences");
    writeFileSync(temporaryPath, JSON.stringify(preferences) + "\n", {
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function chromePreferencesPath(profileDir: string): string {
  const lastUsed = readProfileMetadata(
    join(profileDir, "Local State"),
  )?.last_used;
  const profileName =
    typeof lastUsed === "string" &&
    lastUsed !== "" &&
    lastUsed !== "." &&
    lastUsed !== ".." &&
    basename(lastUsed) === lastUsed
      ? lastUsed
      : "Default";
  return join(profileDir, profileName, "Preferences");
}

function readProfileMetadata(
  path: string,
): { last_used?: unknown; exit_type?: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isPlainObject(value)) {
      const profile = value.profile;
      if (isPlainObject(profile)) {
        return profile;
      }
    }
  } catch {
    // Leave missing or unreadable session metadata to Chrome's normal startup.
  }
  return undefined;
}
