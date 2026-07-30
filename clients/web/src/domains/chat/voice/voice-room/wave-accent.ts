import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { resolveRenderedAvatarAccentHex } from "@/hooks/use-avatar-accent-var";

/**
 * Accent hex for the listening waves, matching the avatar {@link ChatAvatar}
 * actually renders — in the room, the composer voice bar, and the title-bar
 * pill.
 *
 * A thin alias for {@link resolveRenderedAvatarAccentHex}, which holds the one
 * implementation. The iOS Live Activity tints itself from the same value, and
 * an island whose color disagreed with the waves on screen beside it would be a
 * visible bug — so the two must not be able to drift. Kept under its own name
 * because it reads better at the wave call sites and because that import path
 * is what they already use.
 */
export function resolveWaveAccentHex(
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
  customImageUrl: string | null,
): string | null {
  return resolveRenderedAvatarAccentHex(components, traits, customImageUrl);
}
