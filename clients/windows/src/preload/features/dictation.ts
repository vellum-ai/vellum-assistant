import { ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import {
  HELPER_DICTATION_FINALIZED_EVENT,
  HELPER_DICTATION_PARTIAL_EVENT,
  HELPER_DICTATION_SET_PARTIALS,
  HELPER_DICTATION_TRANSCRIBE,
  HELPER_DICTATION_TRANSCRIBED_EVENT,
  HELPER_GET_STATE,
  HELPER_PING,
  HELPER_RESTART,
  HELPER_STATE_EVENT,
  type DictationPartialEvent,
  type HelperState,
  type VellumBridge,
} from "@vellumai/ipc-contract";

const subscribe =
  <T>(channel: string) =>
  (callback: (event: T) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: T): void => {
      callback(payload);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.off(channel, listener);
    };
  };

/**
 * The Windows native helper's dictation bridge. `hotkey` is deliberately
 * absent: Windows has no Fn-key contract, and its configurable global
 * push-to-talk chord ships as its own capability.
 */
const dictation: CapabilityModule<BridgeCapabilityRegistry<VellumBridge>> = {
  id: "dictation",
  install: (registry) => {
    registry.contribute("helper", {
      ping: () => ipcRenderer.invoke(HELPER_PING) as Promise<"pong">,
      getState: () => ipcRenderer.invoke(HELPER_GET_STATE),
      restart: () => ipcRenderer.invoke(HELPER_RESTART),
      onState: subscribe<HelperState>(HELPER_STATE_EVENT),
      dictation: {
        setPartials: (enable, deviceName, pushAudio) =>
          ipcRenderer.invoke(
            HELPER_DICTATION_SET_PARTIALS,
            enable,
            deviceName,
            pushAudio,
          ),
        pushAudioChunk: (chunk) => {
          ipcRenderer.send("vellum:helper:dictation:audio", chunk);
        },
        onPartial: subscribe<DictationPartialEvent>(
          HELPER_DICTATION_PARTIAL_EVENT,
        ),
        onFinalized: subscribe<DictationPartialEvent>(
          HELPER_DICTATION_FINALIZED_EVENT,
        ),
        transcribe: (audio) =>
          ipcRenderer.invoke(HELPER_DICTATION_TRANSCRIBE, audio),
        onTranscribed: subscribe<DictationPartialEvent>(
          HELPER_DICTATION_TRANSCRIBED_EVENT,
        ),
      },
    });
  },
};

export default dictation;
