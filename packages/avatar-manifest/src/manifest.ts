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

const AVATAR_SOURCES: ReadonlySet<string> = new Set<AvatarSource>([
  "builder",
  "upload",
  "ai",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/** Longest string any manifest field may carry (trait ids, etags, timestamps). */
export const AVATAR_FIELD_MAX_LENGTH = 256;

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= AVATAR_FIELD_MAX_LENGTH
  );
}

/** Narrows an unknown value to valid CharacterTraits (presence and length only). */
function isValidCharacterTraits(value: unknown): value is CharacterTraits {
  return (
    isRecord(value) &&
    isBoundedString(value.bodyShape) &&
    isBoundedString(value.eyeStyle) &&
    isBoundedString(value.color)
  );
}

/** Narrows an unknown value to valid AvatarImageMeta (presence and length only). */
function isValidAvatarImageMeta(value: unknown): value is AvatarImageMeta {
  return (
    isRecord(value) &&
    isBoundedString(value.updatedAt) &&
    isBoundedString(value.etag)
  );
}

/**
 * Validates a parsed `avatar.json`. Returns `null` for a non-object, an
 * invalid or missing `kind`, or a valid `kind` whose per-kind payload is
 * missing or malformed, so callers fall back to legacy derivation instead
 * of surfacing an avatar with null traits/image. An unknown `source` and any
 * payload irrelevant to the kind normalize to `null` rather than passing
 * through, so the result always satisfies the wire shape.
 */
export function parseAvatarManifest(value: unknown): AvatarState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.kind !== "string" || !AVATAR_KINDS.has(value.kind)) {
    return null;
  }
  const kind = value.kind as AvatarKind;
  const source =
    typeof value.source === "string" && AVATAR_SOURCES.has(value.source)
      ? (value.source as AvatarSource)
      : null;
  if (kind === "character") {
    if (!isValidCharacterTraits(value.traits)) {
      return null;
    }
    return { kind, traits: value.traits, source, image: null };
  }
  if (kind === "image") {
    if (!isValidAvatarImageMeta(value.image)) {
      return null;
    }
    return { kind, traits: null, source, image: value.image };
  }
  return { kind, traits: null, source, image: null };
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
