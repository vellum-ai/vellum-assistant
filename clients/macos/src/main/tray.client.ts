import { shell, type NativeImage } from "electron";

import {
  configureTrayModel,
  installTray as installSharedTray,
  __resetForTesting,
  type TrayHandlers,
  type TrayMenuIcon,
} from "@vellumai/electron-desktop/tray-model";
import {
  readCompanionHidden,
  readCompanionSize,
  readOnboardingActive,
} from "@vellumai/electron-desktop/window-state";

import {
  MENU_ICON_CIRCLECHECK,
  MENU_ICON_MESSAGECIRCLE,
  MENU_ICON_MESSAGECIRCLEPLUS,
  MENU_ICON_MESSAGESQUARE,
  MENU_ICON_POWER,
  MENU_ICON_REFRESHCW,
  MENU_ICON_SETTINGS,
} from "./assets/menu-icons";
import { acceleratorOption } from "./commands.client";
import {
  setCompanionSurfaceSize,
  setCompanionSurfaceVisible,
} from "./companion-window";
import { getWatchedLockfile } from "./lockfile-watcher.client";
import { dispatchToMain } from "./main-window";
import { menuIcon } from "./menu-icon";
import { readSetting } from "@vellumai/electron-desktop/settings";

const ICONS: Record<TrayMenuIcon, NativeImage> = {
  check: menuIcon(MENU_ICON_CIRCLECHECK),
  feedback: menuIcon(MENU_ICON_MESSAGECIRCLE),
  "new-conversation": menuIcon(MENU_ICON_MESSAGECIRCLEPLUS),
  conversation: menuIcon(MENU_ICON_MESSAGESQUARE),
  power: menuIcon(MENU_ICON_POWER),
  refresh: menuIcon(MENU_ICON_REFRESHCW),
  settings: menuIcon(MENU_ICON_SETTINGS),
};

export type { TrayHandlers };
export { __resetForTesting };

export const installTray = (handlers: TrayHandlers): void => {
  configureTrayModel({
    accelerator: acceleratorOption,
    // macOS is the platform that has the surface. Flat `true` rather than a
    // read of anything: every macOS build has one, and the tray preference
    // below is the only thing that turns it off.
    companionSupported: () => true,
    companionHidden: readCompanionHidden,
    companionSize: readCompanionSize,
    dispatch: dispatchToMain,
    featureEnabled: (flag) => readSetting("featureFlags")?.[flag] === true,
    getLockfile: getWatchedLockfile,
    icon: (icon) => ICONS[icon],
    onboardingActive: readOnboardingActive,
    openComponentGallery: () => {
      void shell.openExternal("http://localhost:6007");
    },
    removePairedLabel: "Remove from this Mac…",
    setCompanionSize: setCompanionSurfaceSize,
    setCompanionVisible: setCompanionSurfaceVisible,
  });
  installSharedTray(handlers);
};
