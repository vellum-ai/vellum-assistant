import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import { createBundleConfirmationBridge } from "@vellumai/electron-desktop/preload";
import type { VellumBridge } from "@vellumai/ipc-contract";

const bundleConfirmationFeature: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "bundle-confirmation",
  install: (bridge) => {
    bridge.contribute(
      "bundleConfirm",
      createBundleConfirmationBridge(ipcRenderer),
    );
  },
};

export default bundleConfirmationFeature;
