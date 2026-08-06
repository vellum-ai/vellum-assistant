import { app, screen } from "electron";

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
} from "@vellumai/electron-desktop/quick-input-window";

import { RENDERER_BASE_PROD, getDevRendererBase } from "../app-config";
import { handle, on } from "../ipc.client";
import { current, dispatchToMain, ensureVisible } from "../main-window";
import { createWindow } from "../windows.client";

const resolveRoute = createWindowRouteResolver(() =>
  app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase(),
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
    configureDictationOverlayWindow({ handle, on });
    configurePopoutWindows({ createWindow, handle, resolveRoute });

    installCommandPaletteWindow();
    installQuickInput();
    installDictationOverlay();
    installPopoutWindows();

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
