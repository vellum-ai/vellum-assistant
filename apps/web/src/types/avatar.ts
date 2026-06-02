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

export function isCharacterTraits(value: unknown): value is CharacterTraits {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.bodyShape === "string" &&
    typeof obj.eyeStyle === "string" &&
    typeof obj.color === "string"
  );
}

export type AvatarKind = "character" | "image" | "none";

export type AvatarSource = "builder" | "upload" | "ai";

export interface AvatarImageMeta {
  updatedAt: string;
  etag: string;
}

/**
 * Authoritative avatar render manifest served by the daemon's
 * `GET /avatar/state` endpoint. `kind` drives rendering; `source` is
 * metadata. Mirrors the daemon's `AvatarState` manifest shape.
 */
export interface AvatarState {
  kind: AvatarKind;
  traits: CharacterTraits | null;
  source: AvatarSource | null;
  image: AvatarImageMeta | null;
}

function isAvatarKind(value: unknown): value is AvatarKind {
  return value === "character" || value === "image" || value === "none";
}

function isAvatarSource(value: unknown): value is AvatarSource {
  return value === "builder" || value === "upload" || value === "ai";
}

function isAvatarImageMeta(value: unknown): value is AvatarImageMeta {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.updatedAt === "string" && typeof obj.etag === "string";
}

export function isAvatarState(value: unknown): value is AvatarState {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    isAvatarKind(obj.kind) &&
    (obj.traits === null || isCharacterTraits(obj.traits)) &&
    (obj.source === null || isAvatarSource(obj.source)) &&
    (obj.image === null || isAvatarImageMeta(obj.image))
  );
}
