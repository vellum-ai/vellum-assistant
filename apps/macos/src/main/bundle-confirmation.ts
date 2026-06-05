import { BrowserWindow, app } from "electron";
import { z } from "zod";

import { RENDERER_BASE_PROD, getDevRendererBase } from "./app-config";
import type { BundleScanData } from "./bundle-manager";
import { handle, on } from "./ipc";
import { createWindow } from "./windows";

// Mirrors `routes.bundleConfirm` in `apps/web/src/utils/routes.ts`.
// Duplicated rather than imported — same convention as `about.ts`.
const CONFIRM_PATH = "/bundle/confirm";

const confirmWindowUrl = (): string => {
  const base = app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase();
  return `${base}${CONFIRM_PATH}`;
};

let confirmationWindow: BrowserWindow | null = null;
let pendingResolve: ((accepted: boolean) => void) | null = null;
let pendingData: BundleScanData | null = null;

export const openBundleConfirmation = (
  data: BundleScanData,
): Promise<boolean> => {
  if (confirmationWindow && !confirmationWindow.isDestroyed()) {
    confirmationWindow.show();
    confirmationWindow.focus();
    return Promise.resolve(false);
  }

  pendingData = data;

  confirmationWindow = createWindow({
    browserWindow: {
      width: 480,
      height: 440,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      titleBarStyle: "hiddenInset",
      show: false,
    },
    navigation: "deny-all",
  });

  confirmationWindow.once("ready-to-show", () => {
    confirmationWindow?.show();
  });

  const promise = new Promise<boolean>((resolve) => {
    pendingResolve = resolve;
  });

  confirmationWindow.on("closed", () => {
    confirmationWindow = null;
    pendingData = null;
    if (pendingResolve) {
      pendingResolve(false);
      pendingResolve = null;
    }
  });

  void confirmationWindow.loadURL(confirmWindowUrl());

  return promise;
};

export const installBundleConfirmation = (): void => {
  handle("vellum:bundleConfirm:getData", z.tuple([]), () => pendingData);

  on(
    "vellum:bundleConfirm:respond",
    z.tuple([z.boolean()]),
    ([accepted]) => {
      if (pendingResolve) {
        pendingResolve(accepted);
        pendingResolve = null;
      }
      if (confirmationWindow) {
        confirmationWindow.close();
      }
    },
  );
};
