/** XDG autostart entries owned by this app. */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { app } from "electron";

import type { LoginItemBackend } from "@vellumai/electron-desktop/login-item";
import { resolveEnvironmentName } from "@vellumai/local-mode";

import { resolveLinuxAppId } from "../../build-resources/app-identity.cjs";
import { LINUX_RELEASE_INFO } from "./app-config";
import log from "./logger";

/** Key stamped on entries we own, so foreign files are never clobbered. */
const OWNER_KEY = "X-Vellum-Autostart";

const autostartDir = (): string =>
  join(
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
    "autostart",
  );

export const autostartEntryPath = (): string =>
  join(
    autostartDir(),
    `${resolveLinuxAppId(app.isPackaged ? LINUX_RELEASE_INFO.releaseChannel : resolveEnvironmentName(process.env))}.desktop`,
  );

const escapeValue = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");

const execCommand = (): string => {
  const executable = process.env.APPIMAGE || process.execPath;
  if (!executable.startsWith("/") || /[\x00-\x1f=]/.test(executable)) {
    throw new Error(
      "The application path cannot be used in an autostart entry",
    );
  }
  const args = [executable];
  if (!app.isPackaged && !process.env.APPIMAGE && process.argv[1]) {
    args.push(process.argv[1]);
  }
  return [
    ...args.map(
      (arg) =>
        `"${escapeValue(arg.replace(/["`$\\]/g, "\\$&").replace(/%/g, "%%"))}"`,
    ),
    "--hidden",
  ].join(" ");
};

const desktopEntry = (): string =>
  [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    `Name=${escapeValue(app.getName())}`,
    `Exec=${execCommand()}`,
    "Terminal=false",
    "Hidden=false",
    "X-GNOME-Autostart-enabled=true",
    `${OWNER_KEY}=true`,
    "",
  ].join("\n");

const readEntry = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const isTrue = (contents: string, key: string): boolean =>
  contents
    .split("\n")
    .some((line) => line.trim().toLowerCase() === `${key.toLowerCase()}=true`);

/**
 * An entry counts as enabled when it exists and is not marked `Hidden=true`,
 * which is how desktop environments disable an entry without deleting it.
 */
const readAutostart = (): boolean => {
  const contents = readEntry(autostartEntryPath());
  return (
    contents !== null &&
    !isTrue(contents, "Hidden") &&
    !/^X-GNOME-Autostart-enabled=false\s*$/m.test(contents)
  );
};

const writeAutostart = (enabled: boolean): boolean => {
  const path = autostartEntryPath();
  const existing = readEntry(path);
  if (existing !== null && !isTrue(existing, OWNER_KEY)) {
    log.warn(`Leaving an autostart entry we do not own untouched: ${path}`);
    return false;
  }
  try {
    if (!enabled) {
      rmSync(path, { force: true });
      return true;
    }
    const contents = desktopEntry();
    mkdirSync(autostartDir(), { recursive: true });
    writeFileSync(path, contents, { mode: 0o644 });
    return true;
  } catch (error) {
    log.error(`Failed to update the autostart entry at ${path}`, error);
    return false;
  }
};

export const autostartLoginItemBackend: LoginItemBackend = {
  read: readAutostart,
  write: writeAutostart,
};
