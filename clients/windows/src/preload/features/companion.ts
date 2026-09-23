import { ipcRenderer } from "electron";
import { createCompanionBridge } from "@vellumai/electron-desktop/companion-preload";
import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import type { VellumBridge } from "@vellumai/ipc-contract";

const feature: CapabilityModule<BridgeCapabilityRegistry<VellumBridge>> = {
  id: "companion",
  install: (registry) => {
    const bridge = createCompanionBridge(ipcRenderer);
    registry.contribute("companion", bridge.companion);
    registry.contribute("voiceActivity", bridge.voiceActivity);
  },
};
export default feature;
