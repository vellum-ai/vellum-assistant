import {
  TOUCH_SURFACE_MEDIA_QUERY,
  useTouchSurface,
} from "@vellumai/design-library/utils/touch-surface";

/**
 * A narrow viewport AND a coarse pointer: a phone, rather than a tablet or a
 * desktop window someone shrank. It is a compound of two axes, not either one
 * of them. The input-capability axis alone is `isPointerCoarse()`; how much
 * fits on screen alone is `useIsMobile()`. See `docs/PLATFORM_ADAPTATION.md`.
 *
 * The compound is only correct when both halves are load-bearing, which is
 * rarer than it looks. Reading it for a question that turns on input alone
 * excludes every roomy touch device: an iPad in either orientation, a phone in
 * landscape, Android tablets.
 *
 * If the alternative branch needs hover, those devices then get an affordance
 * they cannot operate at all.
 *
 * The query itself is defined once in the design library, alongside the
 * `touch-mobile` CSS variant it has to agree with, and is re-exported here so
 * app code has a single module to import (and tests a single module to stub).
 * Imported from the utility's own entry point rather than the package root, so
 * a test that stubs the design library's components does not take the signal
 * with it.
 *
 * @deprecated Prefer a design-library primitive that resolves the presentation
 * itself (`ActionMenu`), or `isPointerCoarse()` for a question about input.
 * Tracked in [LUM-3177](https://linear.app/vellum/issue/LUM-3177).
 */
export const TOUCH_MOBILE_MEDIA_QUERY = TOUCH_SURFACE_MEDIA_QUERY;

/** @deprecated See {@link TOUCH_MOBILE_MEDIA_QUERY}. */
export function useTouchMobile(): boolean {
  return useTouchSurface();
}
