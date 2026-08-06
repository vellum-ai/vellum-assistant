import { app } from "electron";

import {
  configureAboutRuntime,
  installAbout,
  openAboutWindow,
} from "@vellumai/electron-desktop/about";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  configureHotkeySettings,
  HOTKEY_SETTINGS,
} from "@vellumai/electron-desktop/commands";
import { installGlobalShortcuts } from "@vellumai/electron-desktop/global-shortcuts";
import { installHotkeysIpc } from "@vellumai/electron-desktop/hotkeys";
import { installImageContextMenu } from "@vellumai/electron-desktop/image-context-menu";
import { installTextContextMenu } from "@vellumai/electron-desktop/text-context-menu";

import { getDevRendererBase, RENDERER_BASE_PROD } from "../app-config";
import { handle } from "../ipc.client";
import log from "../logger";
import { ensureVisible } from "../main-window";
import { installWindowsMenu } from "../menu";

const commandsFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "commands",
  install: (capabilities) => {
    const hotkeySettings = capabilities.get(HOTKEY_SETTINGS);
    configureHotkeySettings(hotkeySettings);
    if (hotkeySettings) {
      installHotkeysIpc({ handle });
    }

    configureAboutRuntime({
      rendererBase: () =>
        app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase(),
    });
    installAbout({ handle });

    installGlobalShortcuts({
      handlers: {
        globalHotkey: () => {
          void ensureVisible();
        },
      },
      logger: log,
    });
    installWindowsMenu({ handle, openAbout: openAboutWindow });

    app.on("web-contents-created", (_event, contents) => {
      installImageContextMenu(contents);
      installTextContextMenu(contents);
    });
  },
};

export default commandsFeature;
