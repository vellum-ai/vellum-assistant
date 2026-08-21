import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import { createBundleConfirmBridge } from "@vellumai/electron-desktop/preload";
import type { VellumBridge } from "@vellumai/ipc-contract";

const bundlesFeature: CapabilityModule<BridgeCapabilityRegistry<VellumBridge>> =
  {
    id: "bundles",
    install: (registry) => {
      registry.contribute(
        "bundleConfirm",
        createBundleConfirmBridge(ipcRenderer),
      );
    },
  };

export default bundlesFeature;
