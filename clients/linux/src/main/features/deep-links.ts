import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  configureDeepLinks,
  DEEP_LINK_PROTOCOL_REGISTRATION,
  installDeepLinks,
  resolveRegisteredSchemes,
} from "@vellumai/electron-desktop/deep-links";
import {
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
  STARTUP_REGISTRATION,
} from "@vellumai/electron-desktop/login-item";
import {
  onSettingChange,
  readSetting,
  writeSetting,
} from "@vellumai/electron-desktop/settings";
import { resolveEnvironmentName } from "@vellumai/local-mode";

import { autostartLoginItemBackend } from "../autostart";
import { handle, on } from "../ipc.client";
import { ensureVisible } from "../main-window";

const deepLinksFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "deep-links",
  install: (capabilities) => {
    const schemes = resolveRegisteredSchemes(
      resolveEnvironmentName(process.env),
    );
    capabilities.provide(DEEP_LINK_PROTOCOL_REGISTRATION, { schemes });
    capabilities.provide(STARTUP_REGISTRATION, {
      settingsPage: "startup-apps",
    });

    configureDeepLinks({
      ensureVisible,
      handle,
      initialArgv: process.argv,
      on,
    });
    installDeepLinks();

    configureLoginItem({
      backend: autostartLoginItemBackend,
      handle,
      store: {
        read: () => readSetting("launchAtLogin"),
        subscribe: (listener) => onSettingChange("launchAtLogin", listener),
        write: (enabled) => {
          writeSetting("launchAtLogin", enabled);
        },
      },
    });
    installLoginItem();
    installLoginItemIpc();
  },
};

export default deepLinksFeature;
