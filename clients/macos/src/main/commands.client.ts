import {
  configureHotkeySettings,
  type HotkeySettingsProvider,
} from "@vellumai/electron-desktop/commands";

import {
  onSettingChange,
  readSetting,
  writeSetting,
} from "@vellumai/electron-desktop/settings";

const provider: HotkeySettingsProvider = {
  read: () => ({ ...(readSetting("hotkeys") ?? {}) }),
  write: (hotkeys) => {
    writeSetting("hotkeys", hotkeys);
  },
  subscribe: (listener) => onSettingChange("hotkeys", listener),
};

configureHotkeySettings(provider);

export * from "@vellumai/electron-desktop/commands";
