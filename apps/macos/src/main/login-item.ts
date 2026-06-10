import { app } from "electron";

import { readSetting, onSettingChange, writeSetting } from "./settings";

/** Apply the current `launchAtLogin` preference to the OS login item. */
export const syncLoginItem = (): void => {
  const value = readSetting("launchAtLogin");
  app.setLoginItemSettings({ openAtLogin: value ?? false });
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
