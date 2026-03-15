import { getCharacterComponents } from "./character-components.js";

/**
 * Compose a complete SVG document from a body shape, eye style, and color.
 *
 * Ports the transform math from the Swift AvatarCompositor:
 * - Body transform: aspect-fit scale + center translation from body viewBox to output size
 * - Eye transform: remap from eye sourceViewBox to body viewBox (via faceCenter alignment),
 *   then compose with the body-to-output transform
 *
 * @param bodyShapeId - ID of the body shape (e.g. "blob")
 * @param eyeStyleId - ID of the eye style (e.g. "grumpy")
 * @param colorId - ID of the body color (e.g. "green")
 * @param size - Output SVG width/height in px (default 512)
 * @returns A complete SVG document string
 */
export function composeSvg(
  bodyShapeId: string,
  eyeStyleId: string,
  colorId: string,
  size: number = 512,
): string {
  const components = getCharacterComponents();

  const bodyShape = components.bodyShapes.find((b) => b.id === bodyShapeId);
  if (!bodyShape) {
    throw new Error(
      `Unknown body shape: "${bodyShapeId}". Valid IDs: ${components.bodyShapes.map((b) => b.id).join(", ")}`,
    );
  }

  const eyeStyle = components.eyeStyles.find((e) => e.id === eyeStyleId);
  if (!eyeStyle) {
    throw new Error(
      `Unknown eye style: "${eyeStyleId}". Valid IDs: ${components.eyeStyles.map((e) => e.id).join(", ")}`,
    );
  }

  const color = components.colors.find((c) => c.id === colorId);
  if (!color) {
    throw new Error(
      `Unknown color: "${colorId}". Valid IDs: ${components.colors.map((c) => c.id).join(", ")}`,
    );
  }

  // Resolve face center: check overrides first, fall back to body shape default
  const override = components.faceCenterOverrides.find(
    (o) => o.bodyShape === bodyShapeId && o.eyeStyle === eyeStyleId,
  );
  const faceCenter = override ? override.faceCenter : bodyShape.faceCenter;

  // Body transform: aspect-fit scale from body viewBox to output size
  const bodyVB = bodyShape.viewBox;
  const bodyScale = Math.min(size / bodyVB.width, size / bodyVB.height);
  const bodyTx = (size - bodyVB.width * bodyScale) / 2;
  const bodyTy = (size - bodyVB.height * bodyScale) / 2;

  // Eye remap transform: map eye sourceViewBox -> body viewBox coordinates,
  // aligning eyeCenter to faceCenter with aspect-fit scaling
  const eyeVB = eyeStyle.sourceViewBox;
  const remapScale = Math.min(
    bodyVB.width / eyeVB.width,
    bodyVB.height / eyeVB.height,
  );
  const remapTx = faceCenter.x - eyeStyle.eyeCenter.x * remapScale;
  const remapTy = faceCenter.y - eyeStyle.eyeCenter.y * remapScale;

  // Compose remap with body transform (both are scale+translate, no rotation):
  // composedScale = bodyScale * remapScale
  // composedTx = bodyScale * remapTx + bodyTx
  // composedTy = bodyScale * remapTy + bodyTy
  const composedScale = bodyScale * remapScale;
  const composedTx = bodyScale * remapTx + bodyTx;
  const composedTy = bodyScale * remapTy + bodyTy;

  const bodyTransform = `matrix(${bodyScale},0,0,${bodyScale},${bodyTx},${bodyTy})`;
  const eyeTransform = `matrix(${composedScale},0,0,${composedScale},${composedTx},${composedTy})`;

  // Build SVG paths
  const bodyPath = `<path d="${bodyShape.svgPath}" fill="${color.hex}" transform="${bodyTransform}"/>`;

  const eyePaths = eyeStyle.paths
    .map(
      (p) =>
        `<path d="${p.svgPath}" fill="${p.color}" transform="${eyeTransform}"/>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bodyPath}${eyePaths}</svg>`;
}
