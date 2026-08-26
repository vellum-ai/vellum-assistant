import { nativeImage, nativeTheme, type NativeImage } from "electron";

import type { MenuIconPair } from "./assets/menu-icons";

const decode = (png: string, scaleFactor: number): NativeImage =>
  nativeImage.createFromBuffer(Buffer.from(png, "base64"), { scaleFactor });

// Repaint every opaque pixel white, keeping the alpha channel, so a black
// glyph reads on a dark context menu.
const invert = (image: NativeImage, scaleFactor: number): NativeImage => {
  // getSize() is logical; the bitmap is physical pixels.
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap({ scaleFactor });
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    bitmap[offset] = 255;
    bitmap[offset + 1] = 255;
    bitmap[offset + 2] = 255;
  }
  return nativeImage.createFromBitmap(bitmap, {
    width: Math.round(width * scaleFactor),
    height: Math.round(height * scaleFactor),
    scaleFactor,
  });
};

const build = (pair: MenuIconPair, dark: boolean): NativeImage => {
  const base = decode(pair.png1x, 1);
  const retina = decode(pair.png2x, 2);
  const image = dark ? invert(base, 1) : base;
  const retinaImage = dark ? invert(retina, 2) : retina;
  image.addRepresentation({
    scaleFactor: 2,
    buffer: retinaImage.toPNG({ scaleFactor: 2 }),
  });
  return image;
};

/**
 * Build a theme-aware context-menu icon from a base64 1x/2x PNG pair.
 * Windows has no template images, so each icon is rendered once per theme
 * and picked at pop time by `nativeTheme.shouldUseDarkColors`.
 */
export const menuIcon = (pair: MenuIconPair): (() => NativeImage) => {
  let light: NativeImage | null = null;
  let dark: NativeImage | null = null;
  return () => {
    if (nativeTheme.shouldUseDarkColors) {
      dark ??= build(pair, true);
      return dark;
    }
    light ??= build(pair, false);
    return light;
  };
};
