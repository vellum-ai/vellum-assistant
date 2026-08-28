/**
 * Shapes for the catalog literal in this package.
 *
 * Declared here rather than derived from the generated OpenAPI types because
 * this is a leaf package with no dependencies, and the clients that consume
 * those generated types depend on it rather than the other way round. The
 * canonical wire shape is the `avatar/character-components` route's
 * `responseBody` schema; these are not exported so no consumer picks them up
 * as a second name for it.
 */

export interface BodyShapeDefinition {
  id: string;
  viewBox: { width: number; height: number };
  faceCenter: { x: number; y: number };
  svgPath: string;
}

export interface EyePathDefinition {
  svgPath: string;
  color: string; // hex e.g. "#F2F2F2"
}

export interface EyeStyleDefinition {
  id: string;
  sourceViewBox: { width: number; height: number };
  eyeCenter: { x: number; y: number };
  paths: EyePathDefinition[];
}

export interface ColorDefinition {
  id: string;
  hex: string; // e.g. "#4C9B50"
}

export interface FaceCenterOverride {
  bodyShape: string;
  eyeStyle: string;
  faceCenter: { x: number; y: number };
}

export interface CharacterComponents {
  bodyShapes: BodyShapeDefinition[];
  eyeStyles: EyeStyleDefinition[];
  colors: ColorDefinition[];
  faceCenterOverrides: FaceCenterOverride[];
}
