import { ipcRenderer } from "electron";

import type { VellumBridge } from "@vellumai/ipc-contract";
import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import { createNotificationsBridge } from "@vellumai/electron-desktop/preload";

// Renderer bridge for native notifications and file sharing, mirroring the
// macOS preload surface channel-for-channel so the renderer's runtime
// wrappers work unchanged.
const notificationsShare: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "notifications-share",
  install: (bridge) => {
    bridge.contribute("notifications", createNotificationsBridge(ipcRenderer));
    bridge.contribute("share", {
      shareFile: (bytes: Uint8Array, filename: string) =>
        ipcRenderer.invoke(
          "vellum:share:file",
          bytes,
          filename,
        ) as Promise<void>,
    });
  },
};

export default notificationsShare;
