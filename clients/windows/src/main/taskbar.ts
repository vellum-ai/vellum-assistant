import path from "node:path";

import {
  app,
  nativeImage,
  type BrowserWindow,
  type NativeImage,
} from "electron";
import { z } from "zod";

import { DOCK_SET_BADGE, type AssistantStatus } from "@vellumai/ipc-contract";
import { onAvatarChange } from "@vellumai/electron-desktop/avatar";
import { avatarBitmap } from "@vellumai/electron-desktop/avatar-image";
import {
  applyAlphaMask,
  roundedRectCoverage,
} from "@vellumai/electron-desktop/image-mask";
import { getStatus, onStatusChange } from "@vellumai/electron-desktop/status";

import { on } from "./ipc.client";

export interface TaskbarOptions {
  getWindow: () => BrowserWindow | null;
  createOverlayIcon?: (count: number) => NativeImage;
  createAvatarIcon?: () => NativeImage | null;
}

let unreadCount = 0;

const AVATAR_ICON_PX = 256;
const AVATAR_CORNER_RADIUS_RATIO = 0.22;

/** The assistant avatar clipped to a rounded square, or null with no avatar. */
export const createAvatarWindowIcon = (): NativeImage | null => {
  const avatar = avatarBitmap(AVATAR_ICON_PX);
  if (!avatar) {
    return null;
  }
  const masked = applyAlphaMask(
    avatar,
    AVATAR_ICON_PX,
    roundedRectCoverage(
      AVATAR_ICON_PX,
      AVATAR_ICON_PX * AVATAR_CORNER_RADIUS_RATIO,
    ),
  );
  return nativeImage.createFromBitmap(masked, {
    width: AVATAR_ICON_PX,
    height: AVATAR_ICON_PX,
  });
};

// The per-environment app icon electron-builder copies beside the resources;
// absent in dev, where Electron's default icon stays.
let bundleIconCache: NativeImage | null | undefined;
const bundleIcon = (): NativeImage | null => {
  if (bundleIconCache === undefined) {
    const icon = nativeImage.createFromPath(
      path.join(process.resourcesPath ?? "", "icon.ico"),
    );
    bundleIconCache = icon.isEmpty() ? null : icon;
  }
  return bundleIconCache;
};

const BADGE_SIZE = 16;
const BADGE_GLYPHS: Readonly<Record<string, readonly number[]>> = {
  "0": [0b0110, 0b1001, 0b1011, 0b1101, 0b1001, 0b1001, 0b0110],
  "1": [0b0010, 0b0110, 0b0010, 0b0010, 0b0010, 0b0010, 0b0111],
  "2": [0b0110, 0b1001, 0b0001, 0b0010, 0b0100, 0b1000, 0b1111],
  "3": [0b1110, 0b0001, 0b0001, 0b0110, 0b0001, 0b0001, 0b1110],
  "4": [0b0010, 0b0110, 0b1010, 0b1010, 0b1111, 0b0010, 0b0010],
  "5": [0b1111, 0b1000, 0b1000, 0b1110, 0b0001, 0b0001, 0b1110],
  "6": [0b0110, 0b1000, 0b1000, 0b1110, 0b1001, 0b1001, 0b0110],
  "7": [0b1111, 0b0001, 0b0010, 0b0010, 0b0100, 0b0100, 0b0100],
  "8": [0b0110, 0b1001, 0b1001, 0b0110, 0b1001, 0b1001, 0b0110],
  "9": [0b0110, 0b1001, 0b1001, 0b0111, 0b0001, 0b0001, 0b0110],
  "+": [0b0000, 0b0010, 0b0010, 0b1111, 0b0010, 0b0010, 0b0000],
};

const setPixel = (
  bitmap: Buffer,
  x: number,
  y: number,
  red: number,
  green: number,
  blue: number,
): void => {
  const offset = (y * BADGE_SIZE + x) * 4;
  bitmap[offset] = blue;
  bitmap[offset + 1] = green;
  bitmap[offset + 2] = red;
  bitmap[offset + 3] = 255;
};

export const createUnreadOverlayIcon = (count: number): NativeImage => {
  const bitmap = Buffer.alloc(BADGE_SIZE * BADGE_SIZE * 4);
  for (let y = 0; y < BADGE_SIZE; y += 1) {
    for (let x = 0; x < BADGE_SIZE; x += 1) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      if (dx * dx + dy * dy <= 56.25) {
        setPixel(bitmap, x, y, 217, 74, 59);
      }
    }
  }

  const label = count > 99 ? "99+" : String(count);
  const scale = label.length === 1 ? 2 : 1;
  const glyphWidth = 4 * scale;
  const spacing = scale;
  const labelWidth = label.length * glyphWidth + (label.length - 1) * spacing;
  const startX = Math.floor((BADGE_SIZE - labelWidth) / 2);
  const startY = Math.floor((BADGE_SIZE - 7 * scale) / 2);

  for (const [glyphIndex, character] of [...label].entries()) {
    const rows = BADGE_GLYPHS[character];
    if (!rows) {
      continue;
    }
    const glyphX = startX + glyphIndex * (glyphWidth + spacing);
    for (const [rowIndex, row] of rows.entries()) {
      for (let column = 0; column < 4; column += 1) {
        if ((row & (1 << (3 - column))) === 0) {
          continue;
        }
        for (let scaleY = 0; scaleY < scale; scaleY += 1) {
          for (let scaleX = 0; scaleX < scale; scaleX += 1) {
            setPixel(
              bitmap,
              glyphX + column * scale + scaleX,
              startY + rowIndex * scale + scaleY,
              255,
              255,
              255,
            );
          }
        }
      }
    }
  }

  return nativeImage.createFromBitmap(bitmap, {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
  });
};

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
  const overlayIcons = new Map<number, NativeImage>();
  const createOverlayIcon =
    options.createOverlayIcon ?? createUnreadOverlayIcon;
  const createAvatarIcon = options.createAvatarIcon ?? createAvatarWindowIcon;
  // Mirrors the macOS Dock: show the avatar once one exists, restore the
  // bundled icon when it is cleared, and leave the first paint alone.
  let avatarApplied = false;
  const applyAvatar = (): void => {
    const win = options.getWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    const icon = createAvatarIcon();
    if (icon) {
      win.setIcon(icon);
      avatarApplied = true;
      return;
    }
    if (!avatarApplied) {
      return;
    }
    const bundle = bundleIcon();
    if (bundle) {
      win.setIcon(bundle);
      avatarApplied = false;
    }
  };
  const apply = (): void => {
    const win = options.getWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    if (unreadCount > 0) {
      const label = `${unreadCount} unread conversation${unreadCount === 1 ? "" : "s"}`;
      const visualCount = Math.min(unreadCount, 100);
      let overlayIcon = overlayIcons.get(visualCount);
      if (!overlayIcon) {
        overlayIcon = createOverlayIcon(visualCount);
        overlayIcons.set(visualCount, overlayIcon);
      }
      win.setOverlayIcon(overlayIcon, label);
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
  const unsubscribeAvatar = onAvatarChange(applyAvatar);
  app.on("browser-window-created", () => {
    queueMicrotask(apply);
    queueMicrotask(applyAvatar);
  });
  app.on("before-quit", () => {
    unreadCount = 0;
    apply();
    unsubscribeStatus();
    unsubscribeAvatar();
  });
};
