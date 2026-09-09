/**
 * Whether an element is currently on screen.
 *
 * A thin `IntersectionObserver` wrapper, added because the codebase had three
 * hand-rolled copies (the app card's lazy preview, the PDF page renderer, the
 * transcript's load-more sentinel). Those three are left alone; they each fold
 * extra behaviour into their observer.
 *
 * Reports `false` before the first observation and wherever the API is missing,
 * so callers get the conservative answer while the browser catches up. A caller
 * for which "not observable" means "show it" (a lazily loaded picture that is
 * the content, not an enhancement of it) checks for the API itself.
 */

import { useEffect, useState, type RefObject } from "react";

export function useInView(
  ref: RefObject<Element | null>,
  {
    threshold = 0,
    rootMargin,
  }: {
    /**
     * Fraction of the element that must be showing to count as visible. The
     * default asks for any sliver, which is the right test for "the user can
     * already see this, so don't show them a second copy of it".
     */
    threshold?: number;
    /** Grows the viewport the element is tested against, e.g. `"200px"` to start loading just before it scrolls in. */
    rootMargin?: string;
  } = {},
): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }
        setInView(entry.isIntersecting);
      },
      { threshold, rootMargin },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      // An element that is no longer observed is not on screen. Without this a
      // control that scrolls out of the virtualised transcript would leave its
      // last "visible" answer behind and suppress the floating copy forever.
      setInView(false);
    };
  }, [ref, threshold, rootMargin]);

  return inView;
}
