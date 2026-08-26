export type AvatarKind = "character" | "image" | "none";
export type AvatarSource = "builder" | "upload" | "ai";

export interface CharacterTraits {
  bodyShape: string;
  eyeStyle: string;
  color: string;
}

export interface AvatarImageMeta {
  updatedAt: string;
  etag: string;
}

/** The persisted manifest (`avatar.json`). */
export interface AvatarState {
  kind: AvatarKind;
  traits: CharacterTraits | null;
  source: AvatarSource | null;
  image: AvatarImageMeta | null;
}

const AVATAR_KINDS: ReadonlySet<string> = new Set<AvatarKind>([
  "character",
  "image",
  "none",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Narrows an unknown value to valid CharacterTraits (presence check only). */
function isValidCharacterTraits(value: unknown): value is CharacterTraits {
  return (
    isRecord(value) &&
    isNonEmptyString(value.bodyShape) &&
    isNonEmptyString(value.eyeStyle) &&
    isNonEmptyString(value.color)
  );
}

/** Narrows an unknown value to valid AvatarImageMeta (presence check only). */
function isValidAvatarImageMeta(value: unknown): value is AvatarImageMeta {
  return (
    isRecord(value) &&
    isNonEmptyString(value.updatedAt) &&
    isNonEmptyString(value.etag)
  );
}

/**
 * Validates a parsed `avatar.json`. Returns `null` for a non-object, an
 * invalid or missing `kind`, or a valid `kind` whose per-kind payload is
 * missing or malformed, so callers fall back to legacy derivation instead
 * of surfacing an avatar with null traits/image.
 */
export function parseAvatarManifest(value: unknown): AvatarState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.kind !== "string" || !AVATAR_KINDS.has(value.kind)) {
    return null;
  }
  const kind = value.kind as AvatarKind;
  if (kind === "character" && !isValidCharacterTraits(value.traits)) {
    return null;
  }
  if (kind === "image" && !isValidAvatarImageMeta(value.image)) {
    return null;
  }
  return {
    kind,
    traits: (value.traits as CharacterTraits | null) ?? null,
    source: (value.source as AvatarSource | null) ?? null,
    image: (value.image as AvatarImageMeta | null) ?? null,
  };
}

type LegacyAvatarDerivation =
  | { kind: "character"; traits: CharacterTraits }
  | { kind: "image" }
  | { kind: "none" };

/**
 * Derives the avatar from the legacy sidecar files when there is no usable
 * manifest. Traits-first: valid traits win even when the PNG also exists,
 * because the builder writes the rendered PNG after the traits file, so
 * mtimes cannot tell a built character from an uploaded image.
 */
export function deriveAvatarFromLegacyFiles(input: {
  traitsJson: unknown;
  hasImage: boolean;
}): LegacyAvatarDerivation {
  if (isValidCharacterTraits(input.traitsJson)) {
    return { kind: "character", traits: input.traitsJson };
  }
  return input.hasImage ? { kind: "image" } : { kind: "none" };
}

type ResolvedAvatar =
  | { kind: "character"; traits: CharacterTraits }
  | { kind: "image"; image: AvatarImageMeta | null }
  | { kind: "none" };

/**
 * Resolves the avatar from the parsed avatar files: the manifest when it is
 * valid, otherwise the legacy derivation. `image` carries the manifest's
 * metadata when the manifest decided, and is null for a legacy PNG.
 */
export function resolveAvatarFromFiles(input: {
  manifestJson: unknown;
  traitsJson: unknown;
  hasImage: boolean;
}): ResolvedAvatar {
  const manifest = parseAvatarManifest(input.manifestJson);
  if (manifest) {
    switch (manifest.kind) {
      case "character":
        return {
          kind: "character",
          traits: manifest.traits as CharacterTraits,
        };
      case "image":
        return { kind: "image", image: manifest.image };
      case "none":
        return { kind: "none" };
    }
  }
  const legacy = deriveAvatarFromLegacyFiles(input);
  return legacy.kind === "image" ? { kind: "image", image: null } : legacy;
}
