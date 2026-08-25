import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@vellumai/electron-desktop/capability-registry";
import { createScreenRecordingPreloadBridge } from "@vellumai/electron-desktop/screen-recording-preload";
import type { VellumBridge } from "@vellumai/ipc-contract";

const screenRecording: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "screen-recording",
  install: (registry) => {
    registry.contribute(
      "screenRecording",
      createScreenRecordingPreloadBridge(ipcRenderer),
    );
  },
};

export default screenRecording;
