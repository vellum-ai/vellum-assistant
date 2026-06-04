import { useEffect } from "react";

import { isElectron } from "@/runtime/is-electron";
import { setAssistantIcon } from "@/runtime/icon";
import { resolveAvatarRender } from "@/utils/avatar-render";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

/**
 * Square the avatar is rasterized to before publishing. 512px covers the
 * largest consumer (the macOS Dock icon); main downsamples for the menu-bar
 * Tray. Matches the native app's avatar rendering size.
 */
const ICON_SIZE = 512;

/**
 * The largest centered square of a `srcW`×`srcH` source — the source rect for
 * an `object-cover` draw, matching the in-app `ChatAvatar` so non-square
 * uploads render identically on the icon surfaces instead of being stretched.
 * Returns null for a degenerate (zero-dimension) source so the caller draws
 * nothing rather than throwing.
 */
export function coverCropSquare(
  srcW: number,
  srcH: number,
): { sx: number; sy: number; side: number } | null {
  if (srcW <= 0 || srcH <= 0) return null;
  const side = Math.min(srcW, srcH);
  return { sx: (srcW - side) / 2, sy: (srcH - side) / 2, side };
}

/**
 * Draw `src` (an SVG data URI or a renderer-owned blob URL) onto an offscreen
 * canvas at `size`×`size` and return the PNG bytes. Returns null if the image
 * can't be drawn so the caller can fall back to the bundled mark.
 *
 * Non-square sources are center-cropped to a square before scaling (see
 * `coverCropSquare`) so a portrait or logo renders identically on the
 * Dock/menu-bar icons instead of being stretched to fill the square canvas.
 */
async function rasterizeAvatar(
  src: string,
  size: number,
): Promise<Uint8Array | null> {
  const image = new Image();
  image.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => {
      resolve();
    };
    image.onerror = () => {
      reject(new Error("avatar image failed to load"));
    };
  });
  image.src = src;
  await loaded;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);

  // `naturalWidth/Height` is the decoded pixel size (SVG sources fall back to
  // `width/height`, which equal `size` here). Scale the centered square crop
  // to fill the canvas, preserving aspect ratio.
  const crop = coverCropSquare(
    image.naturalWidth || image.width,
    image.naturalHeight || image.height,
  );
  if (crop) {
    ctx.drawImage(
      image,
      crop.sx,
      crop.sy,
      crop.side,
      crop.side,
      0,
      0,
      size,
      size,
    );
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Publish the assistant's avatar to the Electron host so the main process can
 * drive both icon surfaces — the macOS Dock icon and the menu-bar Tray base
 * image — from one source, mirroring the native app where the same avatar
 * feeds `applicationIconImage` and the menu-bar item.
 *
 * Source precedence (character SVG → custom image → none) is shared with the
 * browser favicon via `resolveAvatarRender`, so the two surfaces never drift.
 * The renderer rasterizes because Electron's `nativeImage` only decodes
 * PNG/JPEG, not the trait-composited SVG; main owns per-surface masking and
 * the bundled-Vellum-mark fallback. Publishing `null` (no avatar, or a
 * rasterization failure) tells main to restore that fallback.
 *
 * Everything no-ops off Electron — `rasterizeAvatar` is gated behind
 * `isElectron()` so web/iOS hosts never do the canvas work. Mounted in
 * `RootLayout` next to the favicon sync so both consume the same avatar data.
 */
export function useElectronIconSync(
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): void {
  useEffect(() => {
    if (!isElectron()) return;

    const render = resolveAvatarRender(
      customImageUrl,
      components,
      traits,
      ICON_SIZE,
    );
    if (render.kind === "none") {
      setAssistantIcon(null);
      return;
    }

    let cancelled = false;
    const src = render.kind === "character" ? render.dataUri : render.url;
    void rasterizeAvatar(src, ICON_SIZE)
      .then((bytes) => {
        if (!cancelled) setAssistantIcon(bytes);
      })
      .catch(() => {
        if (!cancelled) setAssistantIcon(null);
      });

    return () => {
      cancelled = true;
    };
  }, [customImageUrl, components, traits]);
}
