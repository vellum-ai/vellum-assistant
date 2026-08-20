import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  KEYBOARD_OPEN_THRESHOLD_PX,
  useVisibleViewport,
} from "@/hooks/use-visible-viewport";

/**
 * Returns `true` while a soft keyboard is open, at any viewport width.
 *
 * On the iOS shell the visible-viewport state reports the keyboard height
 * announced at the leading edge of the show animation, so this flips true
 * before the native frame resize lands; elsewhere it flips at the measured
 * height.
 *
 * Prefer this over {@link useKeyboardOpen} for behaviour that should follow
 * the keyboard itself rather than a phone-width layout: a tablet holds a soft
 * keyboard at well over the mobile breakpoint (an iPad in landscape is ~1180px
 * wide), so a width gate would silently switch that behaviour off there.
 * Callers that need "is this a touch device" as well should say so directly,
 * via `isPointerCoarse()`.
 *
 * Tablet windows also resize without rotating (Stage Manager, split view),
 * which `useVisibleViewport` rebases its reference for, so a window that has
 * become shorter cannot read here as a keyboard that never goes away.
 */
export function useSoftKeyboardOpen(): boolean {
  const visibleViewport = useVisibleViewport();
  return (
    visibleViewport !== null &&
    visibleViewport.keyboardHeight > KEYBOARD_OPEN_THRESHOLD_PX
  );
}

/**
 * Returns `true` while the soft keyboard is open on a mobile viewport.
 *
 * The width gate is deliberate here: the consumers are phone-layout rules
 * (the app shell's keyboard-adjusted height, the composer stack collapsing its
 * below-composer rows, mobile overlay sizing) that must not engage on a tablet
 * or desktop even when a keyboard is up. Always `false` on desktop widths; for
 * the keyboard on its own, use {@link useSoftKeyboardOpen}.
 */
export function useKeyboardOpen(): boolean {
  const isMobile = useIsMobile();
  const softKeyboardOpen = useSoftKeyboardOpen();
  return isMobile && softKeyboardOpen;
}
