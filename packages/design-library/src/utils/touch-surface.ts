/**
 * The input-capability signal the library's adaptive surfaces resolve on: a
 * narrow viewport driven by a coarse pointer, i.e. a phone rather than a
 * desktop window someone shrank.
 *
 * Both halves are load-bearing here. Width alone hands a thumb-sized sheet to
 * a tiled Electron window; pointer alone hands one to a touchscreen laptop that
 * has the room for an anchored surface.
 *
 * That balance is what makes the compound safe, and it does not hold
 * everywhere. The width half also excludes roomy touch devices: an iPad in
 * either orientation, a phone in landscape, Android tablets.
 *
 * So a surface whose other branch depends on hover must read `pointer` alone.
 * Those devices report `hover: none`, and an affordance they cannot reveal is
 * unreachable rather than merely cramped. The compound belongs to a pair of
 * presentations that are both usable, which the anchored menu and the sheet
 * are.
 *
 * These are the same media features as the `touch-mobile` Tailwind variant in
 * `tokens.css`, so a component that hides one surface in CSS and substitutes
 * another in JS switches at one point rather than two. `touch-surface.test.ts`
 * parses that variant and fails if the two drift.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer
 * @see https://m3.material.io/foundations/layout/applying-layout/window-size-classes
 */

import { useCallback, useSyncExternalStore } from "react";

export const TOUCH_SURFACE_MEDIA_QUERY =
  "(width < 48rem) and (pointer: coarse)";

/**
 * Whether the current surface is a touch-first one (see
 * {@link TOUCH_SURFACE_MEDIA_QUERY}). Re-renders when that changes, so a
 * rotated tablet or a resized window is picked up without a reload.
 *
 * Prefer letting an adaptive primitive read this over reading it in a caller:
 * a caller that branches sheet-versus-popover itself is re-deciding a question
 * every caller answers the same way.
 */
export function useTouchSurface(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const query = window.matchMedia(TOUCH_SURFACE_MEDIA_QUERY);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const getSnapshot = useCallback(
    () => window.matchMedia(TOUCH_SURFACE_MEDIA_QUERY).matches,
    [],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
