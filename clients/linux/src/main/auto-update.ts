import { autoUpdater } from "electron-updater";

import {
  configureAutoUpdate,
  resolveUpdateFeedUrl,
} from "@vellumai/electron-desktop/auto-update";

import { LINUX_RELEASE_INFO } from "./app-config";
import { handle } from "./ipc.client";
import log from "./logger";

/** Channel-specific `linux-electron/{arch}/` feed for this build. */
export const linuxUpdateFeedUrl = (arch: string = process.arch): string =>
  resolveUpdateFeedUrl(
    LINUX_RELEASE_INFO.releaseChannel,
    "linux-electron",
    arch,
  );

configureAutoUpdate({
  updater: autoUpdater,
  ipc: { handle },
  logger: log,
  environment: LINUX_RELEASE_INFO.releaseChannel,
  feedUrl: linuxUpdateFeedUrl(),
});

export {
  checkForUpdates,
  installAutoUpdate,
  type UpdateState,
  type UpdateStatus,
} from "@vellumai/electron-desktop/auto-update";
