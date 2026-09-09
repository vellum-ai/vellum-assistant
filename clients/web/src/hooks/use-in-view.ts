/**
 * Whether an element is currently on screen.
 *
 * A thin `IntersectionObserver` wrapper. Three hand-rolled copies are left
 * alone, each asking for something this hook does not offer: the app card's
 * lazy preview latches on the first sighting and disconnects, the PDF page
 * renderer observes every page canvas against its own scroll container and
 * reads the page number off each target, and the transcript's load-more
 * sentinel calls back on every entry rather than reporting a boolean.
 *
 * Reports `false` before the first observation and wherever the API is missing,
 * so callers get the conservative answer while the browser catches up. A caller
 * for which "not observable" means "show it" (a lazily loaded picture that is
 * the content, not an enhancement of it) checks for the API itself.
 */

import { useEffect, useState, type RefObject } from "react";

export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      return;
    }
    // Any sliver counts, which is the right test for "the user can already see
    // this, so don't show them a second copy of it".
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setInView(entry.isIntersecting);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      // An element that is no longer observed is not on screen. Without this a
      // control that scrolls out of the virtualised transcript would leave its
      // last "visible" answer behind and suppress the floating copy forever.
      setInView(false);
    };
  }, [ref]);

  return inView;
}
