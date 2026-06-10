import { autoUpdater } from "electron-updater";
import { app, BrowserWindow } from "electron";
import { z } from "zod";

import { handle } from "./ipc";
import log from "./logger";

declare const __VELLUM_ENVIRONMENT__: string;

const CHANNEL: string =
  typeof __VELLUM_ENVIRONMENT__ === "string"
    ? __VELLUM_ENVIRONMENT__
    : "production";

type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

interface UpdateState {
  status: UpdateStatus;
  version?: string;
  progress?: { percent: number; transferred: number; total: number };
  error?: string;
}

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
  autoUpdater.checkForUpdates().catch((err: unknown) => {
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
  autoUpdater.channel = CHANNEL;
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `https://storage.googleapis.com/vellum-${CHANNEL}-releases/mac-electron/${process.arch}/`,
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
