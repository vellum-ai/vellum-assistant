/**
 * Whether an element's content is taller than the element: `scrollHeight`
 * against `clientHeight`, measured on the element a caller caps (with a
 * `max-height` or a `line-clamp`) to decide whether to offer Show more.
 * With `limit`, the content is measured against that height instead, which
 * holds whether or not the cap is on.
 *
 * The element arrives through a callback ref, stored in state the way
 * `useElementSize` stores it, so the hook measures once it mounts. A
 * `ResizeObserver` watches the element and its first child: the element's box
 * changes when the width does, and once it is capped only the child grows as
 * content arrives (a streamed result, a row added to a list). `contentKey`
 * re-measures for a change that moves neither.
 *
 * `paused` holds the last measurement. A caller that removes its cap to show
 * everything and has no `limit` (a `line-clamp` is counted in lines) pauses
 * while expanded, since an uncapped element never overflows and the control
 * that collapses it again would disappear. A paused measure misses content
 * that changes meanwhile, so a caller whose content can be replaced while
 * expanded caps by height and passes `limit` instead.
 */

import { useLayoutEffect, useState } from "react";

interface UseOverflowsOptions {
  /** A value whose change re-measures, for content the observer cannot see. */
  contentKey?: unknown;
  /** Keep the last measurement instead of measuring. */
  paused?: boolean;
  /** Compare the content with this height, in pixels, not the element's. */
  limit?: number;
}

export function useOverflows<T extends HTMLElement>({
  contentKey,
  paused = false,
  limit,
}: UseOverflowsOptions = {}): {
  ref: (el: T | null) => void;
  overflows: boolean;
} {
  const [el, setEl] = useState<T | null>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    if (paused) {
      return;
    }
    if (!el) {
      setOverflows(false);
      return;
    }
    const measure = () =>
      setOverflows(el.scrollHeight > (limit ?? el.clientHeight));
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild);
    }
    return () => observer.disconnect();
  }, [el, contentKey, paused, limit]);

  return { ref: setEl, overflows };
}
