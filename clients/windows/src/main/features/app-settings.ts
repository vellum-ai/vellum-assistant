import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  HOTKEY_SETTINGS,
  type HotkeySettingsProvider,
} from "@vellumai/electron-desktop/commands";
import {
  onSettingChange,
  readSetting,
  writeSetting,
} from "@vellumai/electron-desktop/settings";

const hotkeySettings: HotkeySettingsProvider = {
  read: () => ({ ...(readSetting("hotkeys") ?? {}) }),
  write: (hotkeys) => {
    writeSetting("hotkeys", hotkeys);
  },
  subscribe: (listener) => onSettingChange("hotkeys", listener),
};

const appSettingsFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "app-settings",
  install: (capabilities) => {
    capabilities.provide(HOTKEY_SETTINGS, hotkeySettings);
  },
};

export default appSettingsFeature;
