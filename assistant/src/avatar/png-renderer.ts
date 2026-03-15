import { Resvg } from "@resvg/resvg-js";

import { composeSvg } from "./svg-compositor.js";

export function renderCharacterPng(
  bodyShapeId: string,
  eyeStyleId: string,
  colorId: string,
  size = 512,
): Buffer {
  const svg = composeSvg(bodyShapeId, eyeStyleId, colorId, size);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
  });
  const pngData = resvg.render();
  return Buffer.from(pngData.asPng());
}
