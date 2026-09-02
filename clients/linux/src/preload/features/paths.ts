import { ipcRenderer, webUtils } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import { createFileOpenPreloadBridge } from "@vellumai/electron-desktop/file-open-preload";
import type { VellumBridge } from "@vellumai/ipc-contract";

const module: CapabilityModule<BridgeCapabilityRegistry<VellumBridge>> = {
  id: "paths",
  install: (registry) => {
    const bridge = createFileOpenPreloadBridge({ ipcRenderer, webUtils });
    registry.contribute("fileOpen", bridge.fileOpen);
    registry.contribute("paths", bridge.paths);
  },
};

export default module;
