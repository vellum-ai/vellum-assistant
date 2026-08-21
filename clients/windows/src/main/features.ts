import {
  DesktopCapabilityRegistry,
  installCapabilityModules,
  type CapabilityModuleExport,
} from "@vellumai/electron-desktop/capability-registry";

import { installWindowsLocalModeProviders } from "./local-mode-providers";

const modules = import.meta.glob<
  CapabilityModuleExport<DesktopCapabilityRegistry>
>("./features/*.ts", { eager: true });

export const desktopCapabilities = new DesktopCapabilityRegistry();

export const installMainFeatures = (): void => {
  installWindowsLocalModeProviders(desktopCapabilities);
  installCapabilityModules(desktopCapabilities, modules);
};
