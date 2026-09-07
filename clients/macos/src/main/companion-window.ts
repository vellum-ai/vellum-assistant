/**
 * The macOS half of the companion surface.
 *
 * The controller itself lives in `@vellumai/electron-desktop/companion-window`
 * so every desktop shell draws the same surface; this file hands it the
 * pieces only this shell has: the app's window, the IPC registrars, the
 * system's animation settings, and the native helper the picker and the
 * shared frames come from.
 *
 * Importing it configures the controller, so the modules that already reach
 * the surface through this path keep working unchanged.
 */

import { systemPreferences } from "electron";

import { configureCompanionCaptureSources } from "@vellumai/electron-desktop/companion-capture-sources";
import { configureCompanionWindow } from "@vellumai/electron-desktop/companion-window";

import { runAppleScript } from "./appleScriptExecutor";
import { handle, on } from "./ipc";
import {
  current,
  dispatchToMain,
  ensureVisible,
  onMainWindowVisibilityChange,
} from "./main-window";
import { getSharedCuHelper } from "./sidecar/shared-cu-helper";

configureCompanionWindow({
  handle,
  on,
  currentMainWindow: current,
  dispatchToMain,
  ensureMainWindowVisible: ensureVisible,
  onMainWindowVisibilityChange,
  prefersReducedMotion: () =>
    systemPreferences.getAnimationSettings().prefersReducedMotion,
});

configureCompanionCaptureSources({
  // The same helper the hotkeys, dictation and computer use share.
  call: (method, params) => getSharedCuHelper().call(method, params),
  runChromeAppleScript: runAppleScript,
});

export {
  installCompanionWindow,
  openCompanionWindow,
  setCompanionSurfaceSize,
  setCompanionSurfaceVisible,
  syncCompanionSurface,
} from "@vellumai/electron-desktop/companion-window";
