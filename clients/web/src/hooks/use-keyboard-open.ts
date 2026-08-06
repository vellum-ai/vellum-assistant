import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  KEYBOARD_OPEN_THRESHOLD_PX,
  useVisibleViewport,
} from "@/hooks/use-visible-viewport";

/**
 * Returns `true` while the soft keyboard is open on a mobile viewport.
 *
 * On the iOS shell the visible-viewport state reports the keyboard height
 * announced at the leading edge of the show animation, so this flips true
 * before the native frame resize lands; elsewhere it flips at the measured
 * height. Always `false` on desktop widths.
 */
export function useKeyboardOpen(): boolean {
  const isMobile = useIsMobile();
  const visibleViewport = useVisibleViewport();
  return (
    isMobile &&
    visibleViewport !== null &&
    visibleViewport.keyboardHeight > KEYBOARD_OPEN_THRESHOLD_PX
  );
}
