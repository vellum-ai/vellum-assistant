import path from "node:path";

import { app, nativeImage, shell, type NativeImage } from "electron";

import { openAboutWindow } from "@vellumai/electron-desktop/about";
import { getWatchedLockfile } from "@vellumai/electron-desktop/lockfile-watcher";
import { configureStatusIconFallback } from "@vellumai/electron-desktop/status-icon";
import {
  configureTrayModel,
  installTray,
} from "@vellumai/electron-desktop/tray-model";
import {
  DEFAULT_COMPANION_SIZE,
  type VellumCommand,
} from "@vellumai/ipc-contract";

import { current, ensureVisible, toggleVisibility } from "./main-window";

let cachedIcon: NativeImage | null = null;

export const getTrayIcon = (): NativeImage => {
  if (cachedIcon) {
    return cachedIcon;
  }
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "tray.ico")
    : path.join(app.getAppPath(), "resources", "tray.ico");
  cachedIcon = nativeImage.createFromPath(iconPath);
  return cachedIcon;
};

const dispatch = (command: VellumCommand): void => {
  ensureVisible();
  const win = current();
  if (!win || win.isDestroyed()) {
    return;
  }
  const send = () => win.webContents.send("vellum:command", command);
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
};

export const installWindowsTray = (
  featureEnabled: (flag: string) => boolean,
): void => {
  const icon = getTrayIcon();
  configureStatusIconFallback(icon.isEmpty() ? null : icon);
  configureTrayModel({
    accelerator: () => ({}),
    // Windows has no companion surface, so every companion field here is the
    // inert answer rather than an implementation. The size still has to be a
    // real one: the tray model reads it to mark a radio item, and the menu it
    // would appear in is gated off by `companionSupported` anyway.
    companionSupported: () => false,
    companionHidden: () => true,
    companionSize: () => DEFAULT_COMPANION_SIZE,
    dispatch,
    featureEnabled,
    getLockfile: getWatchedLockfile,
    icon: () => undefined,
    onboardingActive: () => false,
    openComponentGallery: () => {
      void shell.openExternal("http://localhost:6007");
    },
    removePairedLabel: "Remove from this PC\u2026",
    setCompanionSize: () => undefined,
    setCompanionVisible: () => undefined,
  });
  installTray({
    ensureMainWindow: async () => ensureVisible(),
    openAbout: openAboutWindow,
    toggleMainWindow: toggleVisibility,
  });
};
