import { useMediaQuery } from "@/hooks/use-media-query";

/**
 * Media query that marks viewports narrow enough to swap a sidebar rail
 * for an overlay drawer. Mirrors `SidebarPageLayout`'s `md:` breakpoint
 * (768px).
 */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

/**
 * Returns `true` while the viewport matches `MOBILE_MEDIA_QUERY`
 * (`max-width: 767px`).
 *
 * This is the window-size axis: how much room there is. It says nothing about
 * the pointer, so a desktop window narrowed below the breakpoint still has a
 * mouse. Interaction decisions (which overlay a trigger opens, whether a
 * hover affordance can exist) belong to `useTouchMobile()`. See
 * `docs/PLATFORM_ADAPTATION.md`.
 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_MEDIA_QUERY);
}
