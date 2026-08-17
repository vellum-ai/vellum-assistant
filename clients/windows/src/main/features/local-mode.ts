import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  configureLocalMode,
  configureUnavailableLocalMode,
  installLocalMode,
  LOCAL_MODE_CLI,
  LOCAL_MODE_PATHS,
  LOCAL_MODE_SESSION,
} from "@vellumai/electron-desktop/local-mode";
import { refreshLockfileNow } from "@vellumai/electron-desktop/lockfile-watcher";

import { handle } from "../ipc.client";

const UNAVAILABLE_ERROR =
  "Local mode is unavailable until its Windows providers are installed.";

const localModeFeature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "local-mode",
  install: (capabilities) => {
    const cli = capabilities.get(LOCAL_MODE_CLI);
    const paths = capabilities.get(LOCAL_MODE_PATHS);
    const session = capabilities.get(LOCAL_MODE_SESSION);
    if (!cli || !paths || !session) {
      configureUnavailableLocalMode(handle, UNAVAILABLE_ERROR);
      installLocalMode();
      return;
    }

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
