import { autoUpdater } from "electron-updater";

import {
  configureAutoUpdate,
  resolveUpdateFeedUrl,
} from "@vellumai/electron-desktop/auto-update";

import { WINDOWS_RELEASE_INFO } from "./app-config";
import { handle } from "./ipc.client";
import log from "./logger";

/** Channel-specific `win-electron/{arch}/` feed for this build. */
export const windowsUpdateFeedUrl = (arch: string = process.arch): string =>
  resolveUpdateFeedUrl(
    WINDOWS_RELEASE_INFO.releaseChannel,
    "win-electron",
    arch,
  );

configureAutoUpdate({
  updater: autoUpdater,
  ipc: { handle },
  logger: log,
  environment: WINDOWS_RELEASE_INFO.releaseChannel,
  feedUrl: windowsUpdateFeedUrl(),
});

export {
  checkForUpdates,
  installAutoUpdate,
  type UpdateState,
  type UpdateStatus,
} from "@vellumai/electron-desktop/auto-update";
