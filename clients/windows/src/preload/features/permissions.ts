import { ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import {
  PERMISSIONS_GET_STATE,
  PERMISSIONS_OPEN_SETTINGS,
  PERMISSIONS_QUIT_AND_REOPEN,
  PERMISSIONS_REQUEST,
  PERMISSIONS_STATE_EVENT,
  TEXT_INSERT,
  TEXT_OPEN_SETTINGS,
  type SystemPermissionKind,
  type SystemPermissionStateItem,
  type SystemPermissionsState,
  type TextInsertionResult,
  type VellumBridge,
} from "@vellumai/ipc-contract";

const invokeItem = (
  channel: string,
  kind: SystemPermissionKind,
): Promise<SystemPermissionStateItem> =>
  ipcRenderer.invoke(channel, kind) as Promise<SystemPermissionStateItem>;

const permissionsFeature: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "permissions",
  install: (bridge) => {
    bridge.contribute("permissions", {
      getState: () =>
        ipcRenderer.invoke(
          PERMISSIONS_GET_STATE,
        ) as Promise<SystemPermissionsState>,
      request: (kind) => invokeItem(PERMISSIONS_REQUEST, kind),
      openSettings: (kind) => invokeItem(PERMISSIONS_OPEN_SETTINGS, kind),
      quitAndReopen: () =>
        ipcRenderer.invoke(PERMISSIONS_QUIT_AND_REOPEN) as Promise<void>,
      onState: (callback) => {
        const handler = (
          _event: IpcRendererEvent,
          state: SystemPermissionsState,
        ) => callback(state);
        ipcRenderer.on(PERMISSIONS_STATE_EVENT, handler);
        return () => ipcRenderer.off(PERMISSIONS_STATE_EVENT, handler);
      },
    });
    bridge.contribute("text", {
      insertIntoFrontApp: (text) =>
        ipcRenderer.invoke(TEXT_INSERT, text) as Promise<TextInsertionResult>,
      openAutomationSettings: () =>
        ipcRenderer.invoke(TEXT_OPEN_SETTINGS) as Promise<void>,
    });
  },
};

export default permissionsFeature;
