import { z } from "zod";

import { on } from "./ipc";

/**
 * Avatar source of truth for the macOS icon surfaces.
 *
 * The renderer owns the assistant's identity, so it rasterizes the current
 * avatar (character SVG composited from traits, or a custom uploaded image)
 * to a square PNG and publishes the bytes over `vellum:icon:setAvatar`. Main
 * caches the latest PNG and lets each surface present it: the Dock icon
 * (`app.dock.setIcon`) clips it to a rounded square, and the menu-bar (Tray)
 * clips it to a circle under the status dot. This mirrors the native app,
 * where one avatar feeds both `applicationIconImage` and the menu-bar item
 * (`clients/macos/.../Features/Avatar/AvatarAppearanceManager.swift`).
 *
 * Rasterization happens in the renderer because Electron's `nativeImage`
 * decodes only PNG/JPEG, not the trait-composited SVG, and the renderer is
 * the only context with a canvas and the trait compositor. Main owns the
 * per-surface masking and the bundled-Vellum-mark fallback.
 *
 * A `null` publish (no avatar, or a renderer-side rasterization failure) means
 * "fall back to the bundled mark" — the same restore-bundle-icon path the
 * native app takes when there is no custom avatar.
 */

type AvatarListener = () => void;

let currentAvatarPng: Buffer | null = null;
const listeners = new Set<AvatarListener>();

/**
 * The latest published avatar PNG, or `null` when no avatar is set. Consumers
 * decode and mask this per surface; `null` is the signal to use the bundled
 * fallback mark.
 */
export const getAvatarPng = (): Buffer | null => currentAvatarPng;

/**
 * Subscribe to avatar changes. Returns an unsubscribe function. The listener
 * fires on every publish (including a transition to `null`) so each surface
 * can re-render or restore its fallback.
 */
export const onAvatarChange = (listener: AvatarListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Cache a new avatar PNG (or `null` to clear) and notify subscribers. Exported
 * for the IPC handler and unit tests; production renderer traffic arrives
 * through `installAvatarIpc`.
 */
export const setAvatar = (png: Buffer | null): void => {
  currentAvatarPng = png;
  for (const listener of listeners) listener();
};

// The renderer ships raw PNG bytes as a `Uint8Array`, or `null` to clear.
// Electron's structured clone delivers it as a `Uint8Array` (a `Buffer` is a
// subclass), normalized to `Buffer` here so consumers have one type.
const avatarPayloadSchema = z.tuple([z.instanceof(Uint8Array).nullable()]);

/**
 * Register the `vellum:icon:setAvatar` renderer→main channel. Fire-and-forget
 * (`ipcRenderer.send`): publishing an avatar has no return value, and a
 * rejected sender or malformed payload should drop silently rather than
 * surface an error in the renderer. Call once from `whenReady`, before the
 * Dock and Tray install so their initial render reflects any avatar the
 * renderer publishes during bootstrap.
 */
let installed = false;
export const installAvatarIpc = (): void => {
  if (installed) return;
  installed = true;

  on("vellum:icon:setAvatar", avatarPayloadSchema, ([png]) => {
    setAvatar(png === null ? null : Buffer.from(png));
  });
};

// Test seam — exported only for unit-test setup so each test starts from a
// known state. Production code never calls this.
export const __resetForTesting = (): void => {
  installed = false;
  currentAvatarPng = null;
  listeners.clear();
};
