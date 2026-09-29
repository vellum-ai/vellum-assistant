/**
 * The chrome the composer card and its mobile row's controls wear, and the
 * press behaviour every focus-gated control in the mobile composer shares.
 *
 * Its own module because the surfaces live outside the composer: the composer
 * assembles the row and passes the switch down, while `VoiceInputButton` and
 * `LiveVoiceButton` paint themselves. Importing the classes back from
 * `chat-composer.tsx` would close a cycle, and re-typing them in each control
 * is how the row drifts apart one button at a time.
 */

import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * The chat input's own corner radius, shared with the live-voice bar that
 * stacks on the card: they sit 8px apart, and two different radii at that
 * distance read as two unrelated widgets rather than one control area.
 */
export const COMPOSER_RADIUS_CLASS = "rounded-[10px]";

/**
 * The same corner at mobile widths, where the composer card is a 26px pill
 * (half its 52px collapsed height) rather than the desktop panel. The bar
 * tracks whichever card it is stacked on, so the two still read as one control
 * area; a 10px bar over a pill would not.
 */
export const COMPOSER_MOBILE_RADIUS_CLASS = "rounded-[26px]";

/**
 * The 40x40 circle the mobile row's controls stand at.
 *
 * Driven from the composer's own `isMobile` branch, the same signal that
 * produces the row, rather than from the `touch-mobile:` variant. The two
 * disagree on a window dragged under the breakpoint, which would otherwise take
 * the mobile row's structure while every control in it kept desktop chrome. The
 * primitive's own mobile growth is switched off (`expandOnMobile={false}`)
 * wherever these classes land, so one signal owns the whole control. See
 * `docs/PLATFORM_ADAPTATION.md`.
 */
export const MOBILE_CONTROL_CLASS = "h-10 w-10 rounded-full";

/** The 20px glyphs those 40x40 controls carry. */
export const MOBILE_GLYPH_CLASS = "size-5 [&_svg]:size-5";

/**
 * The press wash under the row's unfilled glyphs. The primitive paints one for
 * ghost icon-only buttons under `touch-mobile:` alone, so the row carries its
 * own and every narrow window lights up the same way.
 */
export const MOBILE_GHOST_WASH_CLASS =
  "hover:bg-[var(--surface-active)] active:bg-[var(--surface-active)]";

/**
 * Keeps touch presses from moving focus off the composer's textarea.
 * Cancel the compatibility mousedown to preserve the keyboard and deliver the
 * click. Cancelling pointerdown would suppress the click in WebKit.
 * Mouse controls keep normal focus transfer for keyboard accessibility.
 */
export function preventPressFocusTransfer(event: ReactMouseEvent<HTMLElement>) {
  event.preventDefault();
}
