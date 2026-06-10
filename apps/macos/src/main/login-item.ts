import { app } from "electron";
import { z } from "zod";

import { handle } from "./ipc";
import { readSetting, onSettingChange, writeSetting } from "./settings";

/** Apply the current `launchAtLogin` preference to the OS login item. */
export const syncLoginItem = (): void => {
  const value = readSetting("launchAtLogin");
  app.setLoginItemSettings({ openAtLogin: value ?? false });
};

/**
 * Install the typed launch-at-login IPC surface: `get` returns the current
 * boolean, `set` persists it (the existing `onSettingChange` subscription
 * from `installLoginItem` triggers `syncLoginItem()` in the same tick).
 */
export const installLoginItemIpc = (): void => {
  handle("vellum:launchAtLogin:get", z.tuple([]), () =>
    readSetting("launchAtLogin") ?? false,
  );
  handle("vellum:launchAtLogin:set", z.tuple([z.boolean()]), ([enabled]) => {
    writeSetting("launchAtLogin", enabled);
  });
};

/**
 * Sync on startup and subscribe to future changes. Returns an unsubscribe
 * function for cleanup.
 *
 * On first launch after the setting is introduced, seeds the preference from
 * the current OS login-item state so users who added Vellum manually via
 * System Settings keep their configuration.
 */
export const installLoginItem = (): (() => void) => {
  if (readSetting("launchAtLogin") === null) {
    const { openAtLogin } = app.getLoginItemSettings();
    writeSetting("launchAtLogin", openAtLogin);
  }
  syncLoginItem();
  return onSettingChange("launchAtLogin", () => syncLoginItem());
};
