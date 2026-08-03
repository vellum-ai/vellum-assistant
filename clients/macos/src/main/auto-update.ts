import { autoUpdater } from "electron-updater";
import { app, BrowserWindow } from "electron";
import { z } from "zod";

import type { UpdateState, UpdateStatus } from "@vellumai/ipc-contract";

import { handle } from "./ipc";
import log from "./logger";

declare const __VELLUM_ENVIRONMENT__: string;

const ENVIRONMENT: string =
  typeof __VELLUM_ENVIRONMENT__ === "string"
    ? __VELLUM_ENVIRONMENT__
    : "production";

const BUCKET_ENV = ENVIRONMENT === "production" ? "prod" : ENVIRONMENT;

export type { UpdateState, UpdateStatus };

let currentState: UpdateState = { status: "idle" };

const setState = (next: UpdateState): void => {
  currentState = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("vellum:update:state", currentState);
    }
  }
};

export const checkForUpdates = (): void => {
  autoUpdater
    .checkForUpdates()
    .then((result) => {
      // With `autoDownload`, the download starts *inside* `checkForUpdates`,
      // and electron-updater hands the in-flight download back on the
      // resolved result rather than folding it into the returned promise
      // (`AppUpdater.doCheckForUpdates` → `downloadPromise`). Its
      // `downloadUpdate` re-throws every download failure after emitting
      // `error`, so unless something attaches a handler here the rejection
      // escapes as an unhandled promise rejection in the main process: the
      // shape Sentry records for the "read-only volume" refusal an app
      // launched from ~/Downloads or a mounted DMG hits on every check.
      // The `error` listener below already owns the user-facing state and the
      // logging, so this only has to keep the rejection from escaping.
      result?.downloadPromise?.catch(() => undefined);
    })
    .catch((err: unknown) => {
      log.error("[auto-update] checkForUpdates failed:", err);
    });
};

export const installAutoUpdate = (): void => {
  handle("vellum:update:getState", z.tuple([]), () => currentState);
  handle("vellum:update:check", z.tuple([]), () => checkForUpdates());
  handle("vellum:update:install", z.tuple([]), () =>
    autoUpdater.quitAndInstall(),
  );

  if (!app.isPackaged) return;

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.channel = ENVIRONMENT;
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `https://storage.googleapis.com/vellum-ai-${BUCKET_ENV}-releases/mac-electron/${process.arch}/`,
  });

  autoUpdater.on("checking-for-update", () => {
    setState({ status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    setState({ status: "available", version: info.version });
  });

  autoUpdater.on("download-progress", (progressObj) => {
    setState({
      status: "downloading",
      progress: {
        percent: progressObj.percent,
        transferred: progressObj.transferred,
        total: progressObj.total,
      },
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setState({ status: "downloaded", version: info.version });
  });

  autoUpdater.on("error", (err) => {
    log.error("[auto-update] error:", err);
    setState({ status: "error", error: err.message });
  });

  autoUpdater.on("update-not-available", () => {
    setState({ status: "idle" });
  });

  checkForUpdates();
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
};
