import { app } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { installScreenRecording } from "@vellumai/electron-desktop/screen-recording";

import { handle } from "../ipc.client";

const screenRecording: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "screen-recording",
  install: () => {
    installScreenRecording({
      appDataDir: app.getPath("appData"),
      handle,
    });
  },
};

export default screenRecording;
