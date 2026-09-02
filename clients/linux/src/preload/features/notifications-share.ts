import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  NOTIFICATIONS_ACTION,
  NOTIFICATIONS_SHOW,
  type NotificationActionEvent,
  type ShowNotificationPayload,
  type VellumBridge,
} from "@vellumai/ipc-contract";
import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";

// Renderer bridge for native notifications and file sharing, mirroring the
// macOS preload surface channel-for-channel so the renderer's runtime
// wrappers work unchanged.
const notificationsShare: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "notifications-share",
  install: (bridge) => {
    bridge.contribute("notifications", {
      show: (payload: ShowNotificationPayload) =>
        ipcRenderer.invoke(NOTIFICATIONS_SHOW, payload) as Promise<{
          success: boolean;
          errorMessage?: string;
        }>,
      onAction: (callback) => {
        const handler = (
          _event: IpcRendererEvent,
          event: NotificationActionEvent,
        ) => {
          callback(event);
        };
        ipcRenderer.on(NOTIFICATIONS_ACTION, handler);
        return () => {
          ipcRenderer.off(NOTIFICATIONS_ACTION, handler);
        };
      },
    });
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
