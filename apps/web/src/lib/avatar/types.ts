/** Mirrors the TypeScript interfaces from assistant/src/avatar/character-components.ts */

export interface BodyShapeDefinition {
  id: string;
  viewBox: { width: number; height: number };
  faceCenter: { x: number; y: number };
  svgPath: string;
}

export interface EyePathDefinition {
  svgPath: string;
  color: string;
}

export interface EyeStyleDefinition {
  id: string;
  sourceViewBox: { width: number; height: number };
  eyeCenter: { x: number; y: number };
  paths: EyePathDefinition[];
}

export interface ColorDefinition {
  id: string;
  hex: string;
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

export interface CharacterTraits {
  bodyShape: string;
  eyeStyle: string;
  color: string;
}

/** Runtime type guard for daemon-returned JSON that should conform to CharacterTraits. */
export function isCharacterTraits(value: unknown): value is CharacterTraits {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.bodyShape === "string" &&
    typeof obj.eyeStyle === "string" &&
    typeof obj.color === "string"
  );
}
