import type {
  AvatarState,
  CharacterComponents,
  CharacterTraits,
} from "@/types/avatar";
import { BUNDLED_COLORS } from "@/utils/avatar-bundled-colors";
import { resolveEffectiveTraits } from "@/utils/avatar-render";

/** What the accent is resolved from: the avatar query's cached shape. */
export interface AvatarAccentInputs {
  /** The daemon's manifest, when the avatar came from one; absent for a hand-seeded cache. */
  state?: AvatarState | null;
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
}

/**
 * The one accent hex for an avatar: the colour every surface that tints
 * itself to the assistant paints with, or null when there is no colour yet.
 *
 * The daemon's manifest is the source of truth. It carries the accent for a
 * character (its palette colour) and for an uploaded image (read out of the
 * pixels, or set by the user), so when it is present it is the answer.
 *
 * Without one the accent is the colour of what `ChatAvatar` draws, in the
 * precedence `resolveAvatarRender` fixes: saved traits outrank an uploaded
 * image, so they give their palette colour; an image with no accent from the
 * daemon (an assistant that predates accents, or an image it could not read)
 * has no colour to match, so surfaces keep their own fallback rather than
 * tinting to an avatar nobody can see; and an assistant that never picked
 * traits wears the first palette colour its default creature is drawn in.
 * Null while the avatar is still loading.
 */
export function resolveAvatarAccentHex(
  avatar: AvatarAccentInputs,
): string | null {
  const accent = avatar.state?.accent;
  if (accent) {
    return accent.hex;
  }
  const wearsImage =
    Boolean(avatar.customImageUrl) || avatar.state?.kind === "image";
  if (wearsImage && !avatar.traits) {
    return null;
  }
  const effective = resolveEffectiveTraits(avatar.components, avatar.traits);
  if (!effective) {
    return null;
  }
  const palette = avatar.components?.colors ?? BUNDLED_COLORS;
  return palette.find((c) => c.id === effective.color)?.hex ?? null;
}
