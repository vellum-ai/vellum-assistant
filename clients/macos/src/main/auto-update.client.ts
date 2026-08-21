import { autoUpdater } from "electron-updater";

import {
  configureAutoUpdate,
  resolveUpdateFeedUrl,
} from "@vellumai/electron-desktop/auto-update";

import { handle } from "./ipc";
import log from "./logger";

declare const __VELLUM_ENVIRONMENT__: string;

const ENVIRONMENT: string =
  typeof __VELLUM_ENVIRONMENT__ === "string"
    ? __VELLUM_ENVIRONMENT__
    : "production";

configureAutoUpdate({
  updater: autoUpdater,
  ipc: { handle },
  logger: log,
  environment: ENVIRONMENT,
  feedUrl: resolveUpdateFeedUrl(ENVIRONMENT, "mac-electron", process.arch),
});

export {
  checkForUpdates,
  installAutoUpdate,
  type UpdateState,
  type UpdateStatus,
} from "@vellumai/electron-desktop/auto-update";
