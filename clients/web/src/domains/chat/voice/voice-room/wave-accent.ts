import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { resolveAvatarAccentHex } from "@/hooks/use-avatar-accent-var";

/**
 * Accent hex for the listening waves, matching the avatar {@link ChatAvatar}
 * actually renders in the room.
 *
 * The app-wide `--avatar-accent` (via `resolveAvatarAccentHex`) resolves only an
 * *explicit* trait color and returns null otherwise — but the room renders the
 * default character in color anyway (ChatAvatar falls back to the first palette
 * color when traits are absent). So the waves must mirror that fallback, or a
 * default-avatar assistant gets indigo waves that don't match its green avatar.
 *
 * Null for custom-image / no-character avatars (no color to match) — the waves
 * then keep their aurora fallback.
 */
export function resolveWaveAccentHex(
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): string | null {
  return (
    resolveAvatarAccentHex(components, traits) ??
    components?.colors?.[0]?.hex ??
    null
  );
}
