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
 * Keeps a press from moving focus off the composer's textarea.
 *
 * WebKit blurs the textarea on a press without focusing the pressed button, and
 * the mobile composer is gated on that focus: the pills row above the card goes
 * away before the tap's `click` is dispatched. A pill vanishes outright; the
 * action row's 40px controls shift far enough that the press lands off
 * whichever one the finger started on. Either way the tap does nothing but drop
 * the keyboard.
 *
 * `mousedown` is the press to cancel, not `pointerdown`. WebKit drops the whole
 * compatibility sequence when `pointerdown` is cancelled, `click` included.
 * Cancelling the compatibility `mousedown` suppresses the focus transfer and
 * nothing else. See `docs/CAPACITOR.md` for the event ordering this relies on.
 *
 * Wire it only where a focus-gated row is on screen AND the press is the kind
 * that fails to carry focus. Both halves matter, and neither is the window's
 * width: a pointing device focuses the button it presses, and that button sits
 * inside the shell the gating watches, so the row holds and the click lands on
 * its own. Cancelling the press there would only take the focus the button is
 * owed. A presentation whose surface opens on the `pointerdown` before the
 * press, as the pills' desktop menu does, needs nothing here either.
 *
 * A control that wants the keyboard gone anyway drops focus from its own click
 * handler, by which point the click it depends on has been delivered.
 */
export function preventPressFocusTransfer(event: ReactMouseEvent<HTMLElement>) {
  event.preventDefault();
}
