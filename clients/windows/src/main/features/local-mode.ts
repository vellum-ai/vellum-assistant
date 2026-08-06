import { app } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  configureLocalMode,
  installLocalMode,
  LOCAL_MODE_CLI,
  LOCAL_MODE_PATHS,
  LOCAL_MODE_SESSION,
} from "@vellumai/electron-desktop/local-mode";
import {
  configureLockfileWatcher,
  installLockfileWatcher,
  refreshLockfileNow,
} from "@vellumai/electron-desktop/lockfile-watcher";

import { handle } from "../ipc.client";

const localModeFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "local-mode",
  install: (capabilities) => {
    const cli = capabilities.get(LOCAL_MODE_CLI);
    const paths = capabilities.get(LOCAL_MODE_PATHS);
    const session = capabilities.get(LOCAL_MODE_SESSION);
    if (!cli || !paths || !session) {
      return;
    }

    configureLockfileWatcher(() => paths.lockfilePaths);
    const teardownWatcher = installLockfileWatcher();
    app.once("before-quit", teardownWatcher);

    configureLocalMode({
      cli,
      handle,
      paths,
      refreshLockfile: refreshLockfileNow,
      session,
    });
    installLocalMode();
  },
};

export default localModeFeature;
