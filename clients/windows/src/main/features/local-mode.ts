import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { installLocalMode } from "@vellumai/electron-desktop/local-mode";

const localModeFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "local-mode",
  install: () => {
    installLocalMode();
  },
};

export default localModeFeature;
