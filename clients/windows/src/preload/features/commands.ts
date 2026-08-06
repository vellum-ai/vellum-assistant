import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import type { VellumBridge } from "@vellumai/ipc-contract";

const commandsFeature: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "commands",
  install: (registry) => {
    registry.contribute("menu", {
      setPlatformSession: (has) =>
        ipcRenderer.invoke("vellum:menu:setPlatformSession", has) as Promise<void>,
    });
  },
};

export default commandsFeature;
