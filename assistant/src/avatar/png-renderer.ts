import { getResvg } from "./resvg-lazy.js";
import { composeSvg } from "./svg-compositor.js";

export function renderCharacterPng(
  bodyShapeId: string,
  eyeStyleId: string,
  colorId: string,
  size = 512,
): Buffer {
  const svg = composeSvg(bodyShapeId, eyeStyleId, colorId, size);
  const Resvg = getResvg();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
  });
  const pngData = resvg.render();
  return Buffer.from(pngData.asPng());
}
