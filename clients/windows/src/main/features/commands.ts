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

import { getRendererBase } from "../app-config";
import { handle } from "../ipc.client";
import log from "../logger";
import { current, dispatchToMain, ensureVisible } from "../main-window";
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
      rendererBase: () => getRendererBase(app.isPackaged),
    });
    installAbout({ handle });

    installGlobalShortcuts({
      handlers: {
        globalHotkey: () => {
          void ensureVisible();
        },
        // Talk, from wherever the user is. `registerAll` skips a command with
        // no handler, so without this the binding would be offered in both
        // Keyboard Shortcuts and Voice settings, show as bound, and do
        // nothing. Never raises the window: the point of a global binding is
        // that the user is working somewhere else.
        toggleVoice: () => {
          if (current() !== null) {
            dispatchToMain({ kind: "toggleVoice" });
            return;
          }
          // No renderer to act in. Building one necessarily shows it, which
          // is still better than a press that lands nowhere.
          void ensureVisible().then(() => {
            dispatchToMain({ kind: "toggleVoice" });
          });
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
