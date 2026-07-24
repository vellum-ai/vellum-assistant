import { app } from "electron";
import { z } from "zod";

import { handle } from "./ipc";
import { readSetting, onSettingChange, writeSetting } from "./settings";

const syncLoginItem = (): void => {
  app.setLoginItemSettings({ openAtLogin: readSetting("launchAtLogin") ?? false });
};

export const installLoginItemIpc = (): void => {
  handle("vellum:launchAtLogin:get", z.tuple([]), () =>
    readSetting("launchAtLogin") ?? false,
  );
  handle("vellum:launchAtLogin:set", z.tuple([z.boolean()]), ([enabled]) => {
    writeSetting("launchAtLogin", enabled);
  });
};

// Seeds from the OS login-item state on first launch so users who added
// Vellum manually via System Settings keep their configuration.
export const installLoginItem = (): void => {
  if (readSetting("launchAtLogin") === null) {
    const { openAtLogin } = app.getLoginItemSettings();
    writeSetting("launchAtLogin", openAtLogin);
  }
  syncLoginItem();
  onSettingChange("launchAtLogin", () => syncLoginItem());
};
