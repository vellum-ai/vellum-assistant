import { app } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  configureFileOpen,
  handleFileOpenArgv,
  installFileOpen,
} from "@vellumai/electron-desktop/file-open";

import { handle, on } from "../ipc.client";
import { ensureVisible } from "../main-window";

const module: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "file-open",
  install: () => {
    configureFileOpen({ ensureMainWindowVisible: ensureVisible, handle, on });
    installFileOpen();

    handleFileOpenArgv(process.argv);
    app.on("second-instance", (_event, argv, workingDirectory) => {
      handleFileOpenArgv(argv, workingDirectory);
    });
  },
};

export default module;
