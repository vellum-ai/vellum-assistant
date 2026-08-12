import { ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  ConnectivityState,
  PowerEvent,
  VellumBridge,
} from "@vellumai/ipc-contract";
import {
  CONNECTIVITY_GET,
  CONNECTIVITY_RETRY,
  CONNECTIVITY_SET_DEVICE,
  CONNECTIVITY_STATE,
  DOCK_SET_BADGE,
  FEATURE_FLAGS_SET,
  ICON_SET_AVATAR,
  ICON_SET_CHARACTER,
  IDENTITY_NAME,
  POWER_EVENT,
  STATUS_CONNECTION,
} from "@vellumai/ipc-contract";
import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";

const presence: CapabilityModule<BridgeCapabilityRegistry<VellumBridge>> = {
  id: "presence",
  install: (bridge) => {
    bridge.contribute("featureFlags", {
      set: (flags) => ipcRenderer.send(FEATURE_FLAGS_SET, flags),
    });
    bridge.contribute("status", {
      setConnection: (status) => ipcRenderer.send(STATUS_CONNECTION, status),
    });
    bridge.contribute("identity", {
      setName: (name) => ipcRenderer.send(IDENTITY_NAME, name),
    });
    bridge.contribute("icon", {
      setAvatar: (png) => ipcRenderer.send(ICON_SET_AVATAR, png),
      setCharacter: (character) =>
        ipcRenderer.send(ICON_SET_CHARACTER, character),
    });
    bridge.contribute("dock", {
      setBadge: (count) => ipcRenderer.send(DOCK_SET_BADGE, count),
    });
    bridge.contribute("power", {
      onEvent: (callback) => {
        const handler = (_event: IpcRendererEvent, payload: PowerEvent) => {
          callback(payload);
        };
        ipcRenderer.on(POWER_EVENT, handler);
        return () => ipcRenderer.off(POWER_EVENT, handler);
      },
    });
    bridge.contribute("connectivity", {
      onState: (callback) => {
        const handler = (_event: IpcRendererEvent, state: ConnectivityState) =>
          callback(state);
        ipcRenderer.on(CONNECTIVITY_STATE, handler);
        void (
          ipcRenderer.invoke(CONNECTIVITY_GET) as Promise<ConnectivityState>
        ).then(callback);
        return () => ipcRenderer.off(CONNECTIVITY_STATE, handler);
      },
      get: () =>
        ipcRenderer.invoke(CONNECTIVITY_GET) as Promise<ConnectivityState>,
      setDevice: (online) => ipcRenderer.send(CONNECTIVITY_SET_DEVICE, online),
      retry: () =>
        ipcRenderer.invoke(CONNECTIVITY_RETRY) as Promise<ConnectivityState>,
    });
  },
};

export default presence;
