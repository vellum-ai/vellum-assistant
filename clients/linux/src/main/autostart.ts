/**
 * Launch at login on Linux, via an XDG autostart desktop entry.
 *
 * Electron's `app.setLoginItemSettings` is a no-op on Linux, so the
 * `@vellumai/electron-desktop` login-item backend seam points here instead.
 * The entry lives at `$XDG_CONFIG_HOME/autostart/<appId>.desktop`, where
 * `appId` mirrors `electron-builder.config.cjs` per environment.
 *
 * Spec: https://specifications.freedesktop.org/autostart-spec/latest/
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { app } from "electron";

import type { LoginItemBackend } from "@vellumai/electron-desktop/login-item";
import { resolveEnvironmentName } from "@vellumai/local-mode";

import log from "./logger";

/** Key stamped on entries we own, so foreign files are never clobbered. */
const OWNER_KEY = "X-Vellum-Autostart";

/** Mirrors the `appId` computed in `electron-builder.config.cjs`. */
export const resolveAutostartAppId = (env: string): string =>
  env === "production"
    ? "com.vellum.vellum-assistant-electron"
    : `com.vellum.vellum-assistant-electron-${env}`;

const autostartDir = (): string =>
  join(
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
    "autostart",
  );

export const autostartEntryPath = (): string =>
  join(
    autostartDir(),
    `${resolveAutostartAppId(resolveEnvironmentName(process.env))}.desktop`,
  );

/**
 * The AppImage runtime exposes the outer image path in `APPIMAGE`;
 * `process.execPath` points at the extracted binary, which does not survive
 * a reboot.
 */
const execCommand = (): string =>
  `"${process.env.APPIMAGE || process.execPath}" --hidden`;

const desktopEntry = (): string =>
  [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    `Name=${app.getName()}`,
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
  return contents !== null && !isTrue(contents, "Hidden");
};

const writeAutostart = (enabled: boolean): void => {
  const path = autostartEntryPath();
  const existing = readEntry(path);
  if (existing !== null && !isTrue(existing, OWNER_KEY)) {
    log.warn(`Leaving an autostart entry we do not own untouched: ${path}`);
    return;
  }
  try {
    if (!enabled) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(autostartDir(), { recursive: true });
    writeFileSync(path, desktopEntry(), { mode: 0o644 });
  } catch (error) {
    log.error(`Failed to update the autostart entry at ${path}`, error);
  }
};

export const autostartLoginItemBackend: LoginItemBackend = {
  read: readAutostart,
  write: writeAutostart,
};
