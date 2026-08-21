import { useHoverCapable } from "@vellumai/design-library/utils/hover-capability";

/**
 * Whether the device can hover, which is the only axis that says whether an
 * affordance behind hover is reachable at all.
 *
 * Not a stand-in for anything else: `hover` and `pointer` are independent media
 * features and neither follows from viewport width, so an iPad in landscape
 * reports `hover: none` at 1024px and a desktop window narrowed to 600px keeps
 * its mouse. This is the same question the design library's reveal rules ask, so
 * a row deciding in TypeScript whether to render a hover-revealed control and
 * the CSS deciding whether to paint it stay in agreement.
 *
 * The query is defined once in the design library, alongside the tooltip and
 * reveal rules that have to agree with it, and is re-exported here so app code
 * has a single module to import (and tests a single module to stub). Imported
 * from the utility's own entry point rather than the package root, so a test
 * that stubs the design library's components does not take the signal with it.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover
 */
export { useHoverCapable };

/**
 * Whether a row should render a control that only hover reveals.
 *
 * `hasTouchPath` is the row's answer to "does a thumb reach these same commands
 * another way" (a swipe, a long press, a sheet). Where it does, the hover control
 * is absent rather than merely unpainted: an unpainted control still occupies the
 * cell it shares, so leaving it in is what forces the information beside it out,
 * and it is one more thing that can answer a tap aimed past it. Where it does
 * not, the control renders whatever the capability, since a command the user
 * cannot reach at all is worse than one always on show.
 *
 * Only capability decides this, never window size. A desktop window narrowed
 * past the mobile breakpoint keeps its mouse and gets no gestures, so dropping
 * the affordance there would leave the commands reachable by nothing.
 */
export function useShowsHoverAffordance(hasTouchPath: boolean): boolean {
  const hoverCapable = useHoverCapable();

  return hasTouchPath ? hoverCapable : true;
}
