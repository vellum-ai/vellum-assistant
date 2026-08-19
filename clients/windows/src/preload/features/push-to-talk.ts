import { ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import {
  HELPER_HOTKEY_EVENT,
  HELPER_HOTKEY_SET_PTT,
  type HotkeyEvent,
  type PushToTalkRegistrationResult,
  type VellumBridge,
} from "@vellumai/ipc-contract";

const feature: CapabilityModule<BridgeCapabilityRegistry<VellumBridge>> = {
  id: "push-to-talk",
  install: (bridge) => {
    bridge.contribute("helper", {
      hotkey: {
        setPushToTalk: (activator) =>
          ipcRenderer.invoke(
            HELPER_HOTKEY_SET_PTT,
            activator,
          ) as Promise<PushToTalkRegistrationResult>,
        onEvent: (callback) => {
          const handler = (_event: IpcRendererEvent, hotkey: HotkeyEvent) => {
            callback(hotkey);
          };
          ipcRenderer.on(HELPER_HOTKEY_EVENT, handler);
          return () => ipcRenderer.off(HELPER_HOTKEY_EVENT, handler);
        },
      },
    });
  },
};

export default feature;
