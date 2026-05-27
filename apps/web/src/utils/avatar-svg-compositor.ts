import type {
  BodyShapeDefinition,
  CharacterComponents,
  ColorDefinition,
  EyeStyleDefinition,
} from "@/types/avatar";

export interface AvatarTransforms {
  bodyTransform: string;
  eyeTransform: string;
}

/**
 * Compute the SVG transform strings for body and eye groups.
 */
export function computeTransforms(
  bodyShape: BodyShapeDefinition,
  eyeStyle: EyeStyleDefinition,
  components: CharacterComponents,
  size: number,
): AvatarTransforms {
  const override = components.faceCenterOverrides.find(
    (o) => o.bodyShape === bodyShape.id && o.eyeStyle === eyeStyle.id,
  );
  const faceCenter = override ? override.faceCenter : bodyShape.faceCenter;

  const bodyVB = bodyShape.viewBox;
  const bodyScale = Math.min(size / bodyVB.width, size / bodyVB.height);
  const bodyTx = (size - bodyVB.width * bodyScale) / 2;
  const bodyTy = (size - bodyVB.height * bodyScale) / 2;

  const eyeVB = eyeStyle.sourceViewBox;
  const remapScale = Math.min(
    bodyVB.width / eyeVB.width,
    bodyVB.height / eyeVB.height,
  );
  const remapTx = faceCenter.x - eyeStyle.eyeCenter.x * remapScale;
  const remapTy = faceCenter.y - eyeStyle.eyeCenter.y * remapScale;

  const composedScale = bodyScale * remapScale;
  const composedTx = bodyScale * remapTx + bodyTx;
  const composedTy = bodyScale * remapTy + bodyTy;

  return {
    bodyTransform: `matrix(${bodyScale},0,0,${bodyScale},${bodyTx},${bodyTy})`,
    eyeTransform: `matrix(${composedScale},0,0,${composedScale},${composedTx},${composedTy})`,
  };
}

/**
 * Resolve the active definitions from components + trait IDs.
 */
export function resolveDefinitions(
  components: CharacterComponents,
  bodyShapeId: string,
  eyeStyleId: string,
  colorId: string,
): {
  bodyShape: BodyShapeDefinition;
  eyeStyle: EyeStyleDefinition;
  color: ColorDefinition;
} {
  const bodyShape = components.bodyShapes.find((b) => b.id === bodyShapeId);
  if (!bodyShape) throw new Error(`Unknown body shape: "${bodyShapeId}"`);
  const eyeStyle = components.eyeStyles.find((e) => e.id === eyeStyleId);
  if (!eyeStyle) throw new Error(`Unknown eye style: "${eyeStyleId}"`);
  const color = components.colors.find((c) => c.id === colorId);
  if (!color) throw new Error(`Unknown color: "${colorId}"`);
  return { bodyShape, eyeStyle, color };
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function composeSvg(
  components: CharacterComponents,
  bodyShapeId: string,
  eyeStyleId: string,
  colorId: string,
  size: number = 512,
): string {
  const { bodyShape, eyeStyle, color } = resolveDefinitions(
    components,
    bodyShapeId,
    eyeStyleId,
    colorId,
  );
  return composeSvgFromDefinitions(bodyShape, eyeStyle, color, components, size);
}

export function composeSvgFromDefinitions(
  bodyShape: BodyShapeDefinition,
  eyeStyle: EyeStyleDefinition,
  color: ColorDefinition,
  components: CharacterComponents,
  size: number = 512,
): string {
  const { bodyTransform, eyeTransform } = computeTransforms(bodyShape, eyeStyle, components, size);

  const bodyPath = `<path d="${escapeAttr(bodyShape.svgPath)}" fill="${escapeAttr(color.hex)}" transform="${bodyTransform}"/>`;

  const eyePaths = eyeStyle.paths
    .map(
      (p) =>
        `<path d="${escapeAttr(p.svgPath)}" fill="${escapeAttr(p.color)}" transform="${eyeTransform}"/>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bodyPath}${eyePaths}</svg>`;
}
