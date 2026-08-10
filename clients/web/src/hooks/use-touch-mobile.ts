import { useMediaQuery } from "@/hooks/use-media-query";

/**
 * ANDs the window-size axis with the input-capability axis: a narrow
 * viewport AND a coarse pointer. Mirrors the design-library `touch-mobile`
 * CSS variant; keep this query in sync with the `@custom-variant
 * touch-mobile` definition in the design library.
 */
export const TOUCH_MOBILE_MEDIA_QUERY =
  "(max-width: 767px) and (pointer: coarse)";

/**
 * True on viewports that are both narrow AND coarse-pointered, i.e.
 * phone-shaped devices. False on a tablet in either orientation and on a
 * phone in landscape (coarse but roomy), and false on a narrow desktop
 * window (narrow but mouse-driven).
 *
 * This is a compound of two independent axes, not the input axis. Which
 * overlay a trigger opens, or whether a hover-revealed affordance can exist
 * at all, is `isPointerCoarse()` from `@/utils/pointer`. How much fits on
 * screen is `useIsMobile()`. The compound is right only when both halves
 * genuinely matter at once, e.g. a bottom sheet that wants a thumb AND a
 * window too narrow to anchor a popover in. See
 * `docs/PLATFORM_ADAPTATION.md`.
 *
 * @deprecated Closed to new callers, enforced by the `no-restricted-imports`
 * entry in `eslint.config.mjs`. The existing forks migrate into the design
 * library's adaptive overlay primitive under LUM-3177, after which no caller
 * asks this question at all. New surfaces read the single axis they actually
 * need instead.
 */
export function useTouchMobile(): boolean {
  return useMediaQuery(TOUCH_MOBILE_MEDIA_QUERY);
}
