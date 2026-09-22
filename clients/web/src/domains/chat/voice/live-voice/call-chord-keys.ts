/**
 * The keys a call answers under Option, and how the pill spells them.
 *
 * Apart from the handler so the surface that draws the controls can name the
 * keys without importing the session the handler acts on: the companion pill
 * shows a user what to press, and it has no session of its own.
 */

import {
  detectShortcutPlatform,
  formatAcceleratorHint,
} from "@vellumai/design-library";

import type { CompanionCallShortcuts } from "@/components/companion-surface";

/** Share the screen the pointer is on, or stop the share that is running. */
export const CALL_SHARE_KEY = "s";

/** Draw on the shared surface, or give the mouse back to the desktop. */
export const CALL_DRAW_KEY = "d";

/** Mute the microphone, or unmute it. */
export const CALL_MUTE_MIC_KEY = "m";

/** Mute the assistant's audio, or unmute it. */
export const CALL_MUTE_ASSISTANT_KEY = "a";

/** The key-cap vocabulary a hint is written in, as the design library names it. */
type ShortcutPlatform = NonNullable<
  Parameters<typeof formatAcceleratorHint>[1]
>;

/**
 * Each chord as the pill writes it beside the control's name (`⌥S`), in the
 * vocabulary of the host the pill is drawn on. Spelt from the same constants
 * the binding is armed with, so the caption cannot promise a key the host is
 * not listening for.
 */
export function callChordHints(
  platform: ShortcutPlatform = detectShortcutPlatform(),
): CompanionCallShortcuts {
  const hint = (key: string): string =>
    formatAcceleratorHint(`Alt+${key.toUpperCase()}`, platform);
  return {
    share: hint(CALL_SHARE_KEY),
    draw: hint(CALL_DRAW_KEY),
    muteMicrophone: hint(CALL_MUTE_MIC_KEY),
    muteAssistant: hint(CALL_MUTE_ASSISTANT_KEY),
  };
}
