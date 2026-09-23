import path from "node:path";

import { app, nativeImage, shell, type NativeImage } from "electron";

import { openAboutWindow } from "@vellumai/electron-desktop/about";
import { acceleratorOption } from "@vellumai/electron-desktop/commands";
import { getWatchedLockfile } from "@vellumai/electron-desktop/lockfile-watcher";
import { configureStatusIconFallback } from "@vellumai/electron-desktop/status-icon";
import {
  configureTrayModel,
  installTray,
  type TrayMenuIcon,
} from "@vellumai/electron-desktop/tray-model";
import {
  readOnboardingActive,
  readCompanionHidden,
  readCompanionSize,
} from "@vellumai/electron-desktop/window-state";
import {
  replayCompanionIntro,
  setCompanionSurfaceSize,
  setCompanionSurfaceVisible,
} from "@vellumai/electron-desktop/companion-window";
import { type VellumCommand } from "@vellumai/ipc-contract";

import {
  MENU_ICON_CIRCLECHECK,
  MENU_ICON_MESSAGECIRCLE,
  MENU_ICON_MESSAGECIRCLEPLUS,
  MENU_ICON_MESSAGESQUARE,
  MENU_ICON_POWER,
  MENU_ICON_REFRESHCW,
  MENU_ICON_SETTINGS,
} from "./assets/menu-icons";
import { current, ensureVisible, toggleVisibility } from "./main-window";
import { menuIcon } from "./menu-icon";

const ICONS: Record<TrayMenuIcon, () => NativeImage> = {
  check: menuIcon(MENU_ICON_CIRCLECHECK),
  feedback: menuIcon(MENU_ICON_MESSAGECIRCLE),
  "new-conversation": menuIcon(MENU_ICON_MESSAGECIRCLEPLUS),
  conversation: menuIcon(MENU_ICON_MESSAGESQUARE),
  power: menuIcon(MENU_ICON_POWER),
  refresh: menuIcon(MENU_ICON_REFRESHCW),
  settings: menuIcon(MENU_ICON_SETTINGS),
};

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
    accelerator: acceleratorOption,
    companionSupported: () => true,
    companionHidden: readCompanionHidden,
    companionSize: readCompanionSize,
    replayCompanionIntro,
    dispatch,
    featureEnabled,
    getLockfile: getWatchedLockfile,
    icon: (icon) => ICONS[icon](),
    onboardingActive: readOnboardingActive,
    openComponentGallery: () => {
      void shell.openExternal("http://localhost:6007");
    },
    removePairedLabel: "Remove from this PC\u2026",
    setCompanionSize: setCompanionSurfaceSize,
    setCompanionVisible: setCompanionSurfaceVisible,
  });
  installTray({
    ensureMainWindow: async () => ensureVisible(),
    openAbout: openAboutWindow,
    toggleMainWindow: toggleVisibility,
  });
};
