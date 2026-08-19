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
        ipcRenderer.invoke(
          "vellum:menu:setPlatformSession",
          has,
        ) as Promise<void>,
      titles: () =>
        ipcRenderer.invoke("vellum:menu:titles") as Promise<
          Array<{ id: string; label: string }>
        >,
      popup: (id, x, y) =>
        ipcRenderer.invoke("vellum:menu:popup", id, x, y) as Promise<void>,
    });
  },
};

export default commandsFeature;
