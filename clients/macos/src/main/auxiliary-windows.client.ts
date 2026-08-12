import { app } from "electron";

import { configureCommandPaletteWindow } from "@vellumai/electron-desktop/command-palette-window";
import { configureDictationOverlayWindow } from "@vellumai/electron-desktop/dictation-overlay-window";
import {
  configureFloatingWindows,
  createWindowRouteResolver,
} from "@vellumai/electron-desktop/floating-window";
import { configurePopoutWindows } from "@vellumai/electron-desktop/popout-window";
import { configureQuickInputWindow } from "@vellumai/electron-desktop/quick-input-window";
import {
  restoreBounds,
  track as trackWindowState,
} from "@vellumai/electron-desktop/window-state";

import { RENDERER_BASE_PROD, getDevRendererBase } from "./app-config";
import { handle, on } from "./ipc";
import { current, dispatchToMain, ensureVisible } from "./main-window";
import { createWindow } from "./windows";

const resolveRoute = createWindowRouteResolver(() =>
  app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase(),
);

configureFloatingWindows({
  createWindow,
  platform: "darwin",
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
  platform: "darwin",
  resolveRoute,
});
configureDictationOverlayWindow({ handle, on });
configurePopoutWindows({
  createWindow,
  handle,
  resolveRoute,
  restoreBounds,
  trackWindowState,
});
