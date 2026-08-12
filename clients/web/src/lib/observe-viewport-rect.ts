/**
 * The signals that mean an element's rect in *viewport* space may have moved.
 *
 * `getBoundingClientRect()` is viewport-relative, so a caller that positions
 * something `fixed` against another element has to re-measure whenever either
 * the element's own box changes or the viewport moves underneath it. Those are
 * three separate sources, and missing any one leaves the measurement stale
 * without ever throwing:
 *
 * - a `ResizeObserver` on the element, for its own box changing;
 * - `window`'s `resize`, for the layout viewport changing around a same-sized
 *   element (a window drag, an orientation change);
 * - `visualViewport`'s `resize` **and** `scroll`, for iOS. The soft keyboard
 *   shrinks the visual viewport without touching `window.innerHeight` in mobile
 *   Safari, and iOS then shifts the whole shell by changing `offsetTop`, which
 *   arrives as a `scroll` with no `resize` beside it. `root-layout.tsx` stacks
 *   that compensation onto the notch inset it already pads the shell by, so an
 *   element measured before either lands sits at an offset that no longer
 *   exists.
 *
 * Completeness is a property of the concept, not of any one call site, which is
 * why the list lives in one place: a reader of a hand-rolled subscription has
 * no way to tell whether theirs is the whole set.
 *
 * Deliberately does not measure, hold state, or resolve the element. Callers
 * want different values out of the same rect (a `bottom`, a distance up from
 * the viewport floor, a whole box) and pass their own `onChange`. Sharing the
 * subscription rather than the measurement is what keeps this from becoming a
 * hook with a parameter for every caller's difference.
 *
 * `onChange` is not invoked on subscribe. Callers measure once themselves, in
 * the effect that sets this up, so the first value is visibly theirs.
 *
 * Related, for a size rather than a position: `hooks/use-element-size.ts`.
 */

/** An element to watch, or a nullish placeholder for one that is not there. */
export type ViewportRectTarget = Element | null | undefined;

/**
 * Watch `targets` for anything that can change where they sit in the viewport,
 * calling `onChange` each time. Returns the teardown.
 *
 * Accepts several targets so a caller measuring more than one element (the
 * onboarding tour reads both the header and the side menu into one update)
 * registers the window-level listeners once rather than per element. Nullish
 * targets are skipped, so an optional element needs no guard at the call site.
 */
export function observeViewportRect(
  targets: ViewportRectTarget | ViewportRectTarget[],
  onChange: () => void,
): () => void {
  const observer = new ResizeObserver(onChange);
  for (const target of Array.isArray(targets) ? targets : [targets]) {
    if (target) {
      observer.observe(target);
    }
  }

  window.addEventListener("resize", onChange);
  const visualViewport = window.visualViewport;
  visualViewport?.addEventListener("resize", onChange);
  visualViewport?.addEventListener("scroll", onChange);

  return () => {
    observer.disconnect();
    window.removeEventListener("resize", onChange);
    visualViewport?.removeEventListener("resize", onChange);
    visualViewport?.removeEventListener("scroll", onChange);
  };
}
