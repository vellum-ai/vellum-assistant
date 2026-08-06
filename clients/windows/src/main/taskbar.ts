import { app, type BrowserWindow, type NativeImage } from "electron";
import { z } from "zod";

import { DOCK_SET_BADGE, type AssistantStatus } from "@vellumai/ipc-contract";
import { getStatus, onStatusChange } from "@vellumai/electron-desktop/status";

import { on } from "./ipc.client";

export interface TaskbarOptions {
  getWindow: () => BrowserWindow | null;
  overlayIcon: NativeImage;
}

let unreadCount = 0;

const progressForStatus = (
  status: AssistantStatus,
): { value: number; mode?: "error" | "indeterminate" | "paused" } => {
  switch (status) {
    case "thinking":
      return { value: 2, mode: "indeterminate" };
    case "error":
    case "authFailed":
      return { value: 1, mode: "error" };
    case "disconnected":
      return { value: 1, mode: "paused" };
    case "idle":
      return { value: -1 };
  }
};

export const installTaskbar = (options: TaskbarOptions): void => {
  const apply = (): void => {
    const win = options.getWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    if (unreadCount > 0) {
      const label = `${unreadCount} unread conversation${unreadCount === 1 ? "" : "s"}`;
      win.setOverlayIcon(options.overlayIcon, label);
    } else {
      win.setOverlayIcon(null, "");
    }
    const progress = progressForStatus(getStatus());
    win.setProgressBar(
      progress.value,
      progress.mode ? { mode: progress.mode } : undefined,
    );
  };

  on(DOCK_SET_BADGE, z.tuple([z.number().finite()]), ([count]) => {
    unreadCount = Math.max(0, Math.floor(count));
    apply();
  });
  const unsubscribeStatus = onStatusChange(apply);
  app.on("browser-window-created", () => queueMicrotask(apply));
  app.on("before-quit", () => {
    unreadCount = 0;
    apply();
    unsubscribeStatus();
  });
};
