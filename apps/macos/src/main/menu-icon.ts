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
 * The 2x variant is added as a representation so Retina displays get a
 * crisp rendition without any runtime resizing.
 */
export const menuIcon = (pair: MenuIconPair): NativeImage => {
  const img = nativeImage.createFromBuffer(
    Buffer.from(pair.png2x, "base64"),
    { scaleFactor: 2 },
  );
  img.setTemplateImage(true);
  return img;
};
