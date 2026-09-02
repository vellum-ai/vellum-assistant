/**
 * The assistant's own colour, as the companion's windows draw it.
 *
 * A running call publishes one, and it wins: it is the colour the call
 * surfaces elsewhere are already tinted with. Outside a call the character's
 * palette id resolves to the same hex the app draws the creature in, so the
 * resting capsule is the assistant's colour rather than a component's default.
 *
 * The call's hex is `""` until the avatar resolves and the contract makes no
 * promise it parses, so anything that is not an obvious `#RRGGBB` falls
 * through rather than being handed to CSS, where an invalid value silently
 * drops the custom property and takes the glyph's colour with it. The resolver
 * is handed `null` components on purpose: these windows have no daemon query,
 * so the bundled palette is the only one they can read.
 *
 * Shared by the surface and the display's edge glow, which is what keeps the
 * two lights the same colour.
 */

import { resolveAvatarAccentHex } from "@/hooks/use-avatar-accent-var";

/**
 * The colour a watch session lights the surface in: the creature's ring, and
 * the edge of the display being read.
 *
 * Fixed rather than the assistant's own accent, because the accent already
 * means "a turn is running" and a screen being read is a different fact about
 * the machine. Amber is the tone the host burns for a live capture, so the
 * surface agrees with the menu bar above it.
 */
export const COMPANION_CAPTURE_ACCENT = "#ff9f45";
import type {
  CompanionCharacter,
  VoiceActivityState,
} from "@vellumai/ipc-contract";

export function companionAccentHexFor(
  call: VoiceActivityState | null,
  character: CompanionCharacter | undefined,
): string | undefined {
  const callAccentHex =
    call !== null && /^#[0-9a-f]{6}$/i.test(call.accentHex)
      ? call.accentHex
      : undefined;
  return (
    callAccentHex ??
    resolveAvatarAccentHex(null, character ?? null) ??
    undefined
  );
}
