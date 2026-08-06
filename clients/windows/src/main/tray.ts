import path from "node:path";

import { app, nativeImage, shell, type NativeImage } from "electron";

import { configureStatusIconFallback } from "@vellumai/electron-desktop/status-icon";
import {
  configureTrayModel,
  installTray,
} from "@vellumai/electron-desktop/tray-model";
import { getLockfileData, resolveLockfilePaths } from "@vellumai/local-mode";
import type { Lockfile } from "@vellumai/local-mode/contract";
import type { VellumCommand } from "@vellumai/ipc-contract";

import { current, ensureVisible, toggleVisibility } from "./main-window";

const EMPTY_LOCKFILE: Lockfile = { assistants: [], activeAssistant: null };
const lockfilePaths = resolveLockfilePaths(process.env);
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

const getLockfile = (): Lockfile => {
  const result = getLockfileData(lockfilePaths);
  return result.ok ? result.data : EMPTY_LOCKFILE;
};

export const installWindowsTray = (): void => {
  const icon = getTrayIcon();
  configureStatusIconFallback(icon.isEmpty() ? null : icon);
  configureTrayModel({
    accelerator: () => ({}),
    dispatch,
    featureEnabled: (flag) => flag === "multi-platform-assistant",
    getLockfile,
    icon: () => undefined,
    onboardingActive: () => false,
    openComponentGallery: () => {
      void shell.openExternal("http://localhost:6007");
    },
    removePairedLabel: "Remove from this PC\u2026",
  });
  installTray({
    ensureMainWindow: async () => ensureVisible(),
    isVoicePanelAvailable: () => false,
    openAbout: () => app.showAboutPanel(),
    showVoicePanel: () => undefined,
    toggleMainWindow: toggleVisibility,
  });
};
