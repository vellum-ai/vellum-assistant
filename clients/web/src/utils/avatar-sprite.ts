/**
 * Rasterizes one bundled character to an offscreen canvas, for the canvas
 * crowds (the welcome screen's wave, the upgrade takeover's stream) that draw
 * dozens of characters per frame: one rasterization per character, then a
 * `drawImage` each, is what lets a whole crowd run at frame rate.
 */
import type { CharacterComponents } from "@/types/avatar";

/**
 * Draw one character to an offscreen canvas at its final size. Rasterizing
 * once per character keeps the per-frame cost to a `drawImage` each, which
 * is what lets the whole crowd run at frame rate.
 */
export function renderAvatarSprite(
  components: CharacterComponents,
  bodyIdx: number,
  eyeIdx: number,
  colorIdx: number,
  px: number,
): HTMLCanvasElement | null {
  const body = components.bodyShapes[bodyIdx];
  const eye = components.eyeStyles[eyeIdx];
  const color = components.colors[colorIdx];
  if (!body || !eye || !color) {
    return null;
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const sprite = document.createElement("canvas");
  sprite.width = Math.max(2, Math.ceil(px * dpr));
  sprite.height = sprite.width;
  const ctx = sprite.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.scale(dpr, dpr);

  const bodyBox = body.viewBox;
  const bodyScale = Math.min(px / bodyBox.width, px / bodyBox.height);
  const bodyTx = (px - bodyBox.width * bodyScale) / 2;
  const bodyTy = (px - bodyBox.height * bodyScale) / 2;
  ctx.save();
  ctx.translate(bodyTx, bodyTy);
  ctx.scale(bodyScale, bodyScale);
  ctx.fillStyle = color.hex;
  ctx.fill(new Path2D(body.svgPath));
  ctx.restore();

  const override = components.faceCenterOverrides.find(
    (o) => o.bodyShape === body.id && o.eyeStyle === eye.id,
  );
  const faceCenter = override ? override.faceCenter : body.faceCenter;
  const eyeBox = eye.sourceViewBox;
  const remapScale = Math.min(
    bodyBox.width / eyeBox.width,
    bodyBox.height / eyeBox.height,
  );
  ctx.save();
  ctx.translate(
    bodyScale * (faceCenter.x - eye.eyeCenter.x * remapScale) + bodyTx,
    bodyScale * (faceCenter.y - eye.eyeCenter.y * remapScale) + bodyTy,
  );
  ctx.scale(bodyScale * remapScale, bodyScale * remapScale);
  for (const path of eye.paths) {
    ctx.fillStyle = path.color;
    ctx.fill(new Path2D(path.svgPath));
  }
  ctx.restore();

  return sprite;
}
