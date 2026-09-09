/**
 * The assistant's own colour, as the companion's windows draw it.
 *
 * A running call publishes one, and it wins: it is the colour the call
 * surfaces elsewhere are already tinted with. Outside a call the accent the
 * app's window published with the character is the colour, the same one the
 * app draws every avatar-tinted surface in, so the resting capsule is the
 * assistant's colour whether its avatar is a character or an uploaded image.
 * On a shell that predates the published accent the character's palette id
 * resolves to the same hex the app draws the creature in.
 *
 * The call's hex is `""` until the avatar resolves and the contract makes no
 * promise that either it or the published accent parses, so anything that is
 * not an obvious `#RRGGBB` falls through rather than being handed to CSS,
 * where an invalid value silently drops the custom property and takes the
 * glyph's colour with it.
 *
 * Shared by the surface and the display's edge glow, which is what keeps the
 * two lights the same colour.
 */

import { accentHexForColorId } from "@vellumai/avatar-catalog/colors";
import type {
  CompanionCharacter,
  VoiceActivityState,
} from "@vellumai/ipc-contract";

/**
 * The accent to draw in when none of the three sources resolves one.
 *
 * The same value `--companion-ring-accent` falls back to in `index.css`,
 * named here for the one caller that cannot leave the colour to CSS: ink on a
 * canvas has to be a colour, and a drawing the user makes before an avatar
 * has one still has to be visible and still has to match its own copy on the
 * frame that goes to the call.
 */
export const COMPANION_DEFAULT_ACCENT = "#5eead4";

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

function usableHex(value: string | undefined): string | undefined {
  return value !== undefined && HEX_PATTERN.test(value) ? value : undefined;
}

export function companionAccentHexFor(
  call: VoiceActivityState | null,
  publishedAccentHex: string | undefined,
  character: CompanionCharacter | undefined,
): string | undefined {
  return (
    (call !== null ? usableHex(call.accentHex) : undefined) ??
    usableHex(publishedAccentHex) ??
    accentHexForColorId(character?.color) ??
    undefined
  );
}
