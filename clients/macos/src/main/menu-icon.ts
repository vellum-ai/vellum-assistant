import { nativeImage, type NativeImage } from "electron";

import { type MenuIconPair } from "./assets/menu-icons";

/**
 * Build a macOS template `NativeImage` from a base64-encoded 1x/2x PNG pair.
 *
 * The returned image is marked as a template image so macOS auto-inverts it
 * for dark menu bars and the highlighted/pressed menu-item state — matching
 * the Swift app's `VIcon.nsImage()` which sets `isTemplate = true` on every
 * menu-item icon.
 *
 * Both the 1x (16px) and 2x (32px) representations are registered so the
 * image resolves crisply on both standard and Retina displays.
 */
export const menuIcon = (pair: MenuIconPair): NativeImage => {
  const img = nativeImage.createFromBuffer(
    Buffer.from(pair.png1x, "base64"),
    { scaleFactor: 1 },
  );
  img.addRepresentation({
    scaleFactor: 2,
    buffer: Buffer.from(pair.png2x, "base64"),
  });
  img.setTemplateImage(true);
  return img;
};
