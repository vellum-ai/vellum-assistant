import { app } from "electron";

import { readSetting, onSettingChange } from "./settings";

/** Apply the current `launchAtLogin` preference to the OS login item. */
export const syncLoginItem = (): void => {
  const value = readSetting("launchAtLogin");
  app.setLoginItemSettings({ openAtLogin: value ?? false });
};

/**
 * Sync on startup and subscribe to future changes. Returns an unsubscribe
 * function for cleanup.
 */
export const installLoginItem = (): (() => void) => {
  syncLoginItem();
  return onSettingChange("launchAtLogin", () => syncLoginItem());
};
