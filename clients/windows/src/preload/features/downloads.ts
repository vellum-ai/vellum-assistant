import { ipcRenderer, type IpcRendererEvent } from "electron";

import type { DownloadDoneEvent, VellumBridge } from "@vellumai/ipc-contract";
import { DOWNLOADS_DONE_EVENT, DOWNLOADS_REVEAL } from "@vellumai/ipc-contract";
import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";

// Renderer bridge for download outcome reports and the file-manager reveal,
// mirroring the macOS preload surface channel-for-channel so the renderer's
// runtime wrappers work unchanged.
const downloads: CapabilityModule<BridgeCapabilityRegistry<VellumBridge>> = {
  id: "downloads",
  install: (bridge) => {
    bridge.contribute("downloads", {
      onDone: (callback) => {
        const handler = (
          _event: IpcRendererEvent,
          payload: DownloadDoneEvent,
        ) => {
          callback(payload);
        };
        ipcRenderer.on(DOWNLOADS_DONE_EVENT, handler);
        return () => ipcRenderer.off(DOWNLOADS_DONE_EVENT, handler);
      },
      reveal: (id) => ipcRenderer.invoke(DOWNLOADS_REVEAL, id) as Promise<void>,
    });
  },
};

export default downloads;
