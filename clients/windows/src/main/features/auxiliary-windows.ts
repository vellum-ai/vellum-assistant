import { app, globalShortcut, screen } from "electron";

import {
  configureCommandPaletteWindow,
  installCommandPaletteWindow,
  repositionCommandPaletteWindow,
} from "@vellumai/electron-desktop/command-palette-window";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  configureDictationOverlayWindow,
  installDictationOverlay,
  repositionDictationOverlayWindow,
} from "@vellumai/electron-desktop/dictation-overlay-window";
import {
  configureFloatingWindows,
  createWindowRouteResolver,
} from "@vellumai/electron-desktop/floating-window";
import {
  configurePopoutWindows,
  installPopoutWindows,
} from "@vellumai/electron-desktop/popout-window";
import {
  configureQuickInputWindow,
  installQuickInput,
  repositionQuickInputWindow,
  toggleQuickInput,
} from "@vellumai/electron-desktop/quick-input-window";

import { getRendererBase } from "../app-config";
import {
  installEscapeMonitor,
  setDictationRecording,
} from "../escape-monitor";
import { handle, on } from "../ipc.client";
import log from "../logger";
import { current, dispatchToMain, ensureVisible } from "../main-window";
import { createWindow } from "../windows.client";

const resolveRoute = createWindowRouteResolver(() =>
  getRendererBase(app.isPackaged),
);

const module: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "auxiliary-windows",
  install: () => {
    configureFloatingWindows({
      createWindow,
      platform: "win32",
      resolveRoute,
    });
    configureCommandPaletteWindow({
      currentMainWindow: current,
      dispatchToMain,
      ensureMainWindowVisible: ensureVisible,
      handle,
    });
    configureQuickInputWindow({
      createWindow,
      dispatchToMain,
      ensureMainWindowVisible: ensureVisible,
      handle,
      platform: "win32",
      resolveRoute,
    });
    // Native mouse-move forwarding for the click-through overlay is broken
    // on Windows (see `pollCursorForHover`); poll instead so the Stop button
    // can be hovered and clicked.
    configureDictationOverlayWindow({
      closeOnHide: true,
      pollCursorForHover: true,
      log: (message) => log.info(message),
      handle,
      on,
    });
    configurePopoutWindows({ createWindow, handle, resolveRoute });

    installEscapeMonitor();
    installCommandPaletteWindow();
    installQuickInput();
    installDictationOverlay({ onRecordingLifecycle: setDictationRecording });
    installPopoutWindows();

    if (!globalShortcut.register("Control+Shift+/", toggleQuickInput)) {
      log.warn("[auxiliary-windows] failed to register Quick Input shortcut");
    }

    const repositionTransientWindows = (): void => {
      repositionCommandPaletteWindow();
      repositionQuickInputWindow();
      repositionDictationOverlayWindow();
    };
    screen.on("display-added", repositionTransientWindows);
    screen.on("display-removed", repositionTransientWindows);
    screen.on("display-metrics-changed", repositionTransientWindows);
  },
};

export default module;
