/**
 * The pure half of the avatar store's telemetry: maps a before/after avatar
 * transition onto the `avatar_changed` wire event, so the store stays the one
 * caller of `recordTelemetryEvent`.
 */
import type {
  AvatarChangedTelemetryEvent,
  TelemetryEventBase,
} from "../telemetry/types.js";
import type {
  AvatarSource,
  AvatarState,
  CharacterTraits,
} from "./avatar-manifest.js";

export type AvatarChangeAction =
  | "set_character"
  | "upload_image"
  | "generate_image"
  | "set_accent"
  | "clear";

/** The sources an image can be set from. */
export type ImageSource = Exclude<AvatarSource, "builder">;

/** The action an image write counts as, by where the image came from. */
export const IMAGE_ACTIONS: Readonly<Record<ImageSource, AvatarChangeAction>> =
  { upload: "upload_image", ai: "generate_image" };

/** The `avatar_changed` wire payload minus the fields `recordTelemetryEvent` stamps. */
type AvatarChangedFields = Omit<
  AvatarChangedTelemetryEvent,
  keyof TelemetryEventBase
>;

function sameTraits(
  previous: CharacterTraits | null,
  next: CharacterTraits | null,
): boolean {
  return (
    previous?.bodyShape === next?.bodyShape &&
    previous?.eyeStyle === next?.eyeStyle &&
    previous?.color === next?.color
  );
}

/** An unknown previous source cannot prove a change. */
function sameSource(previous: AvatarState, next: AvatarState): boolean {
  return previous.source === null || previous.source === next.source;
}

/**
 * A previous accent that was never recorded is an automatic one, so only a
 * custom accent over it proves a change.
 */
function sameAccent(previous: AvatarState, next: AvatarState): boolean {
  if (previous.accent === null) {
    return next.accent?.source !== "custom";
  }
  return (
    previous.accent.hex === next.accent?.hex &&
    previous.accent.source === next.accent?.source
  );
}

/**
 * Whether a mutation left the avatar as it was, so the store can skip the
 * event. Image metadata (`etag`, `updatedAt`) is ignored: a rewrite of the
 * same bytes changes it, and two different images can derive the same accent,
 * so the store compares bytes and passes the verdict as `imageBytesChanged`.
 * A manifest derived from legacy files or not yet backfilled carries no
 * source or accent, and an unknown value cannot prove a change.
 */
export function isSameAvatar(
  previous: AvatarState,
  next: AvatarState,
  imageBytesChanged = false,
): boolean {
  if (previous.kind !== next.kind) {
    return false;
  }
  switch (next.kind) {
    case "character":
      return (
        sameTraits(previous.traits, next.traits) && sameAccent(previous, next)
      );
    case "image":
      return (
        !imageBytesChanged &&
        sameSource(previous, next) &&
        sameAccent(previous, next)
      );
    case "none":
      return true;
  }
}

/**
 * The `avatar_changed` fields for a transition. Optional keys are omitted,
 * never set to `null` or `""`: the wire schema requires at least one
 * character, and a single failing field makes the server drop the whole event.
 */
export function avatarChangedFields(
  action: AvatarChangeAction,
  previous: AvatarState,
  next: AvatarState,
  clientOs?: string,
): AvatarChangedFields {
  const fields: AvatarChangedFields = {
    action,
    kind: next.kind,
    previous_kind: previous.kind,
  };
  if (next.kind === "character" && next.traits) {
    fields.body_shape = next.traits.bodyShape;
    fields.eye_style = next.traits.eyeStyle;
    fields.color = next.traits.color;
  }
  if (next.accent) {
    // One casing on the wire: the palette catalog spells its hexes upper case.
    fields.accent_hex = next.accent.hex.toLowerCase();
    fields.accent_source = next.accent.source;
  }
  if (clientOs) {
    fields.client_os = clientOs;
  }
  return fields;
}
