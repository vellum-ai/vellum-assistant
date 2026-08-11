import {
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
} from "@vellumai/electron-desktop/login-item";

import { handle } from "./ipc";
import { onSettingChange, readSetting, writeSetting } from "./settings";

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
