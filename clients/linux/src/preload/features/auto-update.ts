import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import { createUpdateBridge } from "@vellumai/electron-desktop/preload";
import type { VellumBridge } from "@vellumai/ipc-contract";

const autoUpdateFeature: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "auto-update",
  install: (registry) => {
    registry.contribute("update", createUpdateBridge(ipcRenderer));
  },
};

export default autoUpdateFeature;
