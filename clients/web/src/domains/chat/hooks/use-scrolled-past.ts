/**
 * Whether a scroll container is currently scrolled past `threshold` pixels.
 *
 * Reports a boolean rather than the raw offset on purpose: a scroll handler
 * that pushed the offset into state would re-render on every frame of a
 * flick. This one only calls `setState` when the answer actually flips, so a
 * long scroll commits twice (in and out) no matter how far it travels. See
 * `clients/web/docs/CONVENTIONS.md` on keeping scroll work out of the commit
 * stream.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Element/scroll_event}
 */

import { useEffect, useState } from "react";

export function useScrolledPast(
  element: HTMLElement | null,
  threshold: number,
): boolean {
  const [scrolledPast, setScrolledPast] = useState(false);

  useEffect(() => {
    if (!element) {
      setScrolledPast(false);
      return;
    }

    const sync = () => {
      const next = element.scrollTop > threshold;
      setScrolledPast((current) => (current === next ? current : next));
    };

    sync();
    element.addEventListener("scroll", sync, { passive: true });
    return () => element.removeEventListener("scroll", sync);
  }, [element, threshold]);

  return scrolledPast;
}
