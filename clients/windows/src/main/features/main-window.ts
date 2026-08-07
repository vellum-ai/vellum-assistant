import type { BrowserWindow } from "electron";
import {
  capabilityToken,
  type CapabilityModule,
  type DesktopCapabilityRegistry,
  type MainWindowController,
} from "@vellumai/electron-desktop/capability-registry";

import {
  current,
  ensureVisible,
  installMainWindow,
} from "../main-window";

export const MAIN_WINDOW_CONTROLLER = capabilityToken<
  MainWindowController<BrowserWindow>
>("main-window");

const feature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "main-window",
  install: (registry) => {
    installMainWindow();
    registry.provide(MAIN_WINDOW_CONTROLLER, { current, ensureVisible });
  },
};

export default feature;
