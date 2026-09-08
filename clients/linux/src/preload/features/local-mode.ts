import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import { createLocalModeBridge } from "@vellumai/electron-desktop/local-mode-bridge";
import type { VellumBridge } from "@vellumai/ipc-contract";

const localModeFeature: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "local-mode",
  install: (registry) => {
    registry.contribute("localMode", createLocalModeBridge(ipcRenderer));
  },
};

export default localModeFeature;
