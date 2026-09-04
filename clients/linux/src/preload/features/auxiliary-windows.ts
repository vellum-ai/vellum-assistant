import { ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import {
  COMMAND_PALETTE_DISMISS,
  COMMAND_PALETTE_OPEN,
  COMMAND_PALETTE_SELECT,
  DICTATION_OVERLAY_GET_STATE,
  DICTATION_OVERLAY_REQUEST_STOP,
  DICTATION_OVERLAY_SET_HIT_REGION,
  DICTATION_OVERLAY_SET_INTERACTIVE,
  DICTATION_OVERLAY_SET_STATE,
  DICTATION_OVERLAY_STATE_EVENT,
  DICTATION_OVERLAY_STOP_REQUESTED,
  POPOUT_OPEN,
  QUICK_INPUT_DISMISS,
  QUICK_INPUT_SUBMIT,
  type DictationOverlayState,
  type VellumBridge,
} from "@vellumai/ipc-contract";

const module: CapabilityModule<BridgeCapabilityRegistry<VellumBridge>> = {
  id: "auxiliary-windows",
  install: (registry) => {
    registry.contribute("quickInput", {
      submit: (message) => ipcRenderer.invoke(QUICK_INPUT_SUBMIT, message),
      dismiss: () => ipcRenderer.invoke(QUICK_INPUT_DISMISS),
    });
    registry.contribute("commandPalette", {
      open: () => ipcRenderer.invoke(COMMAND_PALETTE_OPEN),
      dismiss: () => ipcRenderer.invoke(COMMAND_PALETTE_DISMISS),
      select: (command) => ipcRenderer.invoke(COMMAND_PALETTE_SELECT, command),
    });
    registry.contribute("dictationOverlay", {
      setState: (state) => {
        ipcRenderer.send(DICTATION_OVERLAY_SET_STATE, state);
      },
      onState: (callback) => {
        const listener = (
          _event: IpcRendererEvent,
          state: DictationOverlayState,
        ): void => {
          callback(state);
        };
        ipcRenderer.on(DICTATION_OVERLAY_STATE_EVENT, listener);
        return () => {
          ipcRenderer.off(DICTATION_OVERLAY_STATE_EVENT, listener);
        };
      },
      getState: () => ipcRenderer.invoke(DICTATION_OVERLAY_GET_STATE),
      requestStop: () => {
        ipcRenderer.send(DICTATION_OVERLAY_REQUEST_STOP);
      },
      onStopRequested: (callback) => {
        const listener = (): void => {
          callback();
        };
        ipcRenderer.on(DICTATION_OVERLAY_STOP_REQUESTED, listener);
        return () => {
          ipcRenderer.off(DICTATION_OVERLAY_STOP_REQUESTED, listener);
        };
      },
      setInteractive: (interactive) => {
        ipcRenderer.send(DICTATION_OVERLAY_SET_INTERACTIVE, interactive);
      },
      setHitRegion: (region) => {
        ipcRenderer.send(DICTATION_OVERLAY_SET_HIT_REGION, region);
      },
    });
    registry.contribute("popout", {
      open: (conversationId) => ipcRenderer.invoke(POPOUT_OPEN, conversationId),
    });
  },
};

export default module;
