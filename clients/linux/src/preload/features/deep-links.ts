import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import {
  createDeepLinksBridge,
  createLaunchAtLoginBridge,
} from "@vellumai/electron-desktop/preload";
import type { VellumBridge } from "@vellumai/ipc-contract";

const deepLinksFeature: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "deep-links",
  install: (registry) => {
    registry.contribute("deepLinks", createDeepLinksBridge(ipcRenderer));
    registry.contribute(
      "launchAtLogin",
      createLaunchAtLoginBridge(ipcRenderer),
    );
  },
};

export default deepLinksFeature;
