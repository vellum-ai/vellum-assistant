/**
 * Answers media queries for a given device shape, so a test can drive the two
 * device-side platform-adaptation axes independently.
 *
 * `narrow` drives the window-size axis (`useIsMobile()`, `max-md:`), and
 * `coarsePointer` drives the input-capability axis (`isPointerCoarse()`).
 * The compound `useTouchMobile()` query falls out of both, which is the point:
 * the combinations that come apart, a roomy touch tablet and a narrow window
 * driven by a mouse, are the ones adaptation bugs hide in. See
 * `docs/PLATFORM_ADAPTATION.md`.
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
    const widthOk = query.includes("min-width")
      ? !narrow
      : !query.includes("max-width") || narrow;
    return {
      matches: widthOk && (!query.includes("pointer: coarse") || coarsePointer),
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
