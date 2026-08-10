/**
 * Whether a query's width condition holds for the given device shape.
 *
 * Both spellings the codebase uses have to answer: `(max-width: 767px)` from
 * `useIsMobile()`, and the level-4 range syntax `(width < 48rem)` the design
 * library's `touch-mobile` query is written in. A query with no width condition
 * is not a width question and passes.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_media_queries/Using_media_queries#syntax_improvements_in_level_4
 */
function widthHolds(query: string, narrow: boolean): boolean {
  if (/max-width|width\s*<=?/.test(query)) {
    return narrow;
  }
  if (/min-width|width\s*>=?/.test(query)) {
    return !narrow;
  }
  return true;
}

/**
 * Whether a query's hover condition holds.
 *
 * A coarse pointer reports `hover: none`, which is the pairing that makes a
 * hover-revealed affordance unreachable rather than merely cramped.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover
 */
function hoverHolds(query: string, coarsePointer: boolean): boolean {
  if (/hover:\s*hover/.test(query)) {
    return !coarsePointer;
  }
  if (/hover:\s*none/.test(query)) {
    return coarsePointer;
  }
  return true;
}

/**
 * Answers media queries for a given device shape, so a test can drive the two
 * device-side platform-adaptation axes independently.
 *
 * `narrow` drives the window-size axis (`useIsMobile()`, `max-md:`), and
 * `coarsePointer` drives the input-capability axis (`isPointerCoarse()`) along
 * with the `hover` it implies. The compound `useTouchMobile()` query falls out
 * of both, which is the point: the combinations that come apart, a roomy touch
 * tablet and a narrow window driven by a mouse, are the ones adaptation bugs
 * hide in. See `docs/PLATFORM_ADAPTATION.md`.
 *
 * Stubbing `window.matchMedia` rather than mocking the hook modules keeps the
 * test honest about which signal the component actually consults, and avoids
 * bun's process-global module mocks leaking into sibling suites.
 *
 * Returns a restore fn the caller invokes once done.
 */
export function stubViewportAxes({
  narrow,
  coarsePointer,
}: {
  narrow: boolean;
  coarsePointer: boolean;
}): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => {
    return {
      matches:
        widthHolds(query, narrow) &&
        hoverHolds(query, coarsePointer) &&
        (!query.includes("pointer: coarse") || coarsePointer),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}
