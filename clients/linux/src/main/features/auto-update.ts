import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";

import { installAutoUpdate } from "../auto-update";

const autoUpdateFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "auto-update",
  install: () => {
    installAutoUpdate();
  },
};

export default autoUpdateFeature;
