import type {
  AvatarCharactercomponentsGetResponses,
  AvatarStateGetResponses,
} from "@/generated/daemon/types.gen";

/**
 * Avatar domain types, derived from the daemon's generated OpenAPI response
 * shapes so the renderer never re-asserts a hand-maintained mirror of the
 * wire contract. The named aliases below are pure indexed-access views of
 * the generated `200` responses for `GET /avatar/state` and
 * `GET /avatar/character-components`; regenerating the client
 * (`bun run openapi-ts`) propagates any contract change here automatically.
 *
 * The runtime guards (`isCharacterTraits`, `isAvatarState`) live here because
 * generated types are compile-time only — code that validates an untrusted
 * payload (e.g. a legacy sidecar file or a cross-version daemon response)
 * still needs a runtime narrowing function.
 */

type AvatarStateResponse = AvatarStateGetResponses[200];
type CharacterComponentsResponse = AvatarCharactercomponentsGetResponses[200];

export type BodyShapeDefinition =
  CharacterComponentsResponse["bodyShapes"][number];

export type EyeStyleDefinition =
  CharacterComponentsResponse["eyeStyles"][number];

export type EyePathDefinition = EyeStyleDefinition["paths"][number];

export type ColorDefinition = CharacterComponentsResponse["colors"][number];

export type FaceCenterOverride =
  CharacterComponentsResponse["faceCenterOverrides"][number];

export type CharacterComponents = CharacterComponentsResponse;

export type CharacterTraits = NonNullable<AvatarStateResponse["traits"]>;

export function isCharacterTraits(value: unknown): value is CharacterTraits {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.bodyShape === "string" &&
    typeof obj.eyeStyle === "string" &&
    typeof obj.color === "string"
  );
}

export type AvatarKind = AvatarStateResponse["kind"];

export type AvatarSource = NonNullable<AvatarStateResponse["source"]>;

export type AvatarImageMeta = NonNullable<AvatarStateResponse["image"]>;

/**
 * Authoritative avatar render manifest served by the daemon's
 * `GET /avatar/state` endpoint. `kind` drives rendering; `source` is
 * metadata.
 */
export type AvatarState = AvatarStateResponse;

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
