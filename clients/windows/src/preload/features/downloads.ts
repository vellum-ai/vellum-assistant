import { ipcRenderer } from "electron";

import type { VellumBridge } from "@vellumai/ipc-contract";
import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import { createDownloadsBridge } from "@vellumai/electron-desktop/preload";

// Renderer bridge for download outcome reports and the file-manager reveal,
// the same shared factory the macOS preload uses.
const downloads: CapabilityModule<BridgeCapabilityRegistry<VellumBridge>> = {
  id: "downloads",
  install: (bridge) => {
    bridge.contribute("downloads", createDownloadsBridge(ipcRenderer));
  },
};

export default downloads;
