import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import type { BundleScanData, VellumBridge } from "@vellumai/ipc-contract";

const bundleConfirm: CapabilityModule<BridgeCapabilityRegistry<VellumBridge>> =
  {
    id: "windows.bundle-confirmation",
    install(registry) {
      registry.contribute("bundleConfirm", {
        getData: () =>
          ipcRenderer.invoke(
            "vellum:bundleConfirm:getData",
          ) as Promise<BundleScanData | null>,
        respond: (accepted) => {
          ipcRenderer.send("vellum:bundleConfirm:respond", accepted);
        },
      });
    },
  };

export default bundleConfirm;
