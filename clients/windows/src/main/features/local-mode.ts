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
import { refreshLockfileNow } from "@vellumai/electron-desktop/lockfile-watcher";

import { handle } from "../ipc.client";
import { installWindowsLocalModeProviders } from "../local-mode-providers";

const localModeFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "local-mode",
  install: (capabilities) => {
    installWindowsLocalModeProviders(capabilities);
    const cli = capabilities.require(LOCAL_MODE_CLI);
    const paths = capabilities.require(LOCAL_MODE_PATHS);
    const session = capabilities.require(LOCAL_MODE_SESSION);

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
