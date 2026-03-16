import { Resvg } from "@resvg/resvg-js";

import { composeSvg } from "./svg-compositor.js";

const RAMP = " .·:;+=xX$&@";

/**
 * Render a character avatar as ASCII art suitable for terminal display.
 *
 * Composes the SVG, rasterizes it via Resvg, then maps each pixel cell to a
 * brightness character. The ramp is dark-background-friendly: spaces for
 * transparent/dark areas, dense characters for bright areas.
 *
 * @param bodyShapeId - ID of the body shape (e.g. "blob")
 * @param eyeStyleId - ID of the eye style (e.g. "curious")
 * @param colorId - ID of the body color (e.g. "green")
 * @param width - Output width in characters (default 60)
 * @returns A multi-line ASCII art string
 */
export function renderCharacterAscii(
  bodyShapeId: string,
  eyeStyleId: string,
  colorId: string,
  width: number = 60,
): string {
  const renderSize = width * 2;
  const svg = composeSvg(bodyShapeId, eyeStyleId, colorId, renderSize);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: renderSize },
  });
  const renderedImage = resvg.render();
  const pixels = renderedImage.pixels;
  const imgWidth = renderedImage.width;
  const imgHeight = renderedImage.height;

  // Each terminal cell is roughly 2x taller than wide, so we sample a
  // rectangular region per cell: cellW pixels wide, cellH = cellW * 2 tall.
  const cellW = imgWidth / width;
  const cellH = cellW * 2;
  const outHeight = Math.floor(imgHeight / cellH);

  const rows: string[] = [];
  for (let r = 0; r < outHeight; r++) {
    let row = "";
    for (let c = 0; c < width; c++) {
      const px = (Math.floor(r * cellH) * imgWidth + Math.floor(c * cellW)) * 4;
      const R = pixels[px];
      const G = pixels[px + 1];
      const B = pixels[px + 2];
      const A = pixels[px + 3];

      const brightness = (0.299 * R + 0.587 * G + 0.114 * B) * (A / 255);
      const idx = Math.min(
        Math.floor((brightness / 256) * RAMP.length),
        RAMP.length - 1,
      );
      row += RAMP[idx];
    }
    rows.push(row);
  }

  return rows.join("\n");
}
