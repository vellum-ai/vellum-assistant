import {
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
} from "@vellumai/electron-desktop/login-item";
import {
  onSettingChange,
  readSetting,
  writeSetting,
} from "@vellumai/electron-desktop/settings";

import { handle } from "./ipc";

configureLoginItem({
  handle,
  store: {
    read: () => readSetting("launchAtLogin"),
    subscribe: (listener) => onSettingChange("launchAtLogin", listener),
    write: (enabled) => {
      writeSetting("launchAtLogin", enabled);
    },
  },
});

export { installLoginItem, installLoginItemIpc };
