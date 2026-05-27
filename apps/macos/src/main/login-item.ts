import { app } from "electron";

import { onSettingChange, readSetting } from "./settings";

const SETTING_KEY = "featureFlags.loginAtStartup";

/**
 * Reads `featureFlags.loginAtStartup` from the settings store and applies it
 * via `app.setLoginItemSettings`, so toggling the setting from the renderer
 * (when a settings UI lands) starts or stops the app launching at macOS
 * login without requiring a restart.
 *
 * The setting defaults to `false` — no opt-in until a user explicitly
 * enables it. Until a renderer-side UI exists, the escape hatch is to edit
 * the `featureFlags.loginAtStartup` key directly in the settings JSON file
 * under `~/Library/Application Support/Vellum Dev/config.json`.
 */
export const installLoginItem = (): void => {
  applyFromSettings();

  // React to renderer writes (theme picker / settings UI in a future ticket
  // will call `window.vellum.settings.set("featureFlags", { ... })`, which
  // fires `onDidChange` for the dotted key below).
  onSettingChange<boolean>(SETTING_KEY, (newValue) => {
    setLoginItem(newValue === true);
  });
};

const applyFromSettings = (): void => {
  const featureFlags = readSetting("featureFlags");
  const enabled =
    typeof featureFlags === "object" &&
    featureFlags !== null &&
    (featureFlags as Record<string, unknown>).loginAtStartup === true;
  setLoginItem(enabled);
};

const setLoginItem = (openAtLogin: boolean): void => {
  app.setLoginItemSettings({ openAtLogin });
};
