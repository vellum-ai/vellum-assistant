import { BrowserWindow } from "electron";
import { z } from "zod";

import { getBundlePlatform } from "./bundle-platform";
import type { BundleScanData } from "./bundle-manager";
import { createWindow } from "./windows";

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

  void confirmationWindow.loadURL(
    `${getBundlePlatform().rendererBase()}/bundle/confirm`,
  );

  return promise;
};

export const installBundleConfirmation = (): void => {
  const bundlePlatform = getBundlePlatform();
  bundlePlatform.ipc.handle(
    "vellum:bundleConfirm:getData",
    z.tuple([]),
    () => pendingData,
  );
  bundlePlatform.ipc.on(
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
