import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

/**
 * One owner for "a pane has a width, the other side takes the rest, you can
 * drag or key the edge, and it is remembered".
 *
 * Four surfaces are that same thing: the sidebar rail, the app-editing split,
 * the Activity/Schedules detail drawer, and the tool-detail drawer. Each used
 * to hold its own copy of the width state, the clamping, the persistence, and
 * the pointer arithmetic, which is how they came to disagree about where the
 * live width is written during a drag and who writes it to storage (LUM-3200).
 *
 * A hook rather than a wrapper component because the three DOM shapes are
 * genuinely different: a `nav` landmark with an absolutely positioned edge, a
 * flex two-pane split, and a `motion.div` whose width is the animated
 * dimension. A wrapper would fight all three.
 *
 * Spread `handleProps` onto {@link PaneResizeHandle}, which implements the
 * keyboard half of the [APG window splitter pattern][apg]. The handle is not
 * usable on its own, by design: a splitter that does not know its own bounds
 * cannot report them, and reporting them is most of what makes it accessible.
 *
 * [apg]: https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/
 */

/** Px moved per arrow press, and the multiplier applied when Shift is held. */
const STEP_PX = 16;
const COARSE_STEP_MULTIPLIER = 4;

/**
 * Read a persisted width, validating both shape and finiteness. Returns `null`
 * for unset or malformed entries and when storage access throws, which it does
 * in strict-privacy contexts, on quota errors, and during SSR.
 */
function readStoredSize(storageKey: string | undefined): number | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored == null) return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredSize(storageKey: string | undefined, size: number): void {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, String(size));
  } catch {
    // Storage quota or security error, ignore.
  }
}

export interface UseResizablePaneOptions {
  /**
   * Which side of the container the sized pane occupies. `"start"` grows as
   * the handle travels right, `"end"` shrinks, so arrow keys can always follow
   * the divider rather than the pane.
   */
  side: "start" | "end";
  /** Width in px before any persisted value or measurement is available. */
  defaultSize: number;
  /** Smallest width the pane may take, in px. */
  minSize: number;
  /** Hard upper bound in px, when the pane has one of its own (a rail's max). */
  maxSize?: number;
  /**
   * Px to reserve for everything the pane does not occupy: the other pane's
   * minimum plus the handle's own width. Combined with the measured container
   * this is what stops a drag from squeezing the other side to nothing.
   * Omit when the pane's bound is absolute rather than container-relative.
   */
  reserveForRest?: number;
  /** `localStorage` key. Omit to make the size session-only. */
  storageKey?: string;
  /** Accessible name for the handle, e.g. "Resize sidebar". */
  label: string;
  /**
   * `id` already on the sized pane, when it has one. `aria-controls` uses it
   * instead of the generated one, so a caller-supplied `id` cannot leave the
   * separator pointing at an element that does not exist.
   */
  paneId?: string;
  /**
   * The element whose width the pane's size *is*. During a drag the size is
   * written straight to its inline style, so tracking the cursor costs no
   * React commit; the commit and the persist happen on release. Omit when
   * something else owns that element's width (an animation, say) and take the
   * per-frame `size` updates instead.
   */
  paneRef?: RefObject<HTMLElement | null>;
  /** Called with the committed size after a drag or a key press. */
  onSizeCommit?: (size: number) => void;
}

export interface ResizablePaneHandleProps {
  role: "separator";
  "aria-orientation": "vertical";
  "aria-label": string;
  "aria-controls": string;
  "aria-valuenow": number;
  "aria-valuemin": number;
  "aria-valuemax": number;
  tabIndex: 0;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

export interface UseResizablePaneResult {
  /** Committed size in px. Does not update per frame while `paneRef` is set. */
  size: number;
  /** Attach to the element that bounds both panes, so the maximum can be measured. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Put on the sized pane. The handle points at it via `aria-controls`. */
  paneId: string;
  /** Spread onto {@link PaneResizeHandle}. */
  handleProps: ResizablePaneHandleProps;
  /** True while a pointer drag is in flight, for suppressing transitions. */
  isResizing: boolean;
}

export function useResizablePane({
  side,
  defaultSize,
  minSize,
  maxSize,
  reserveForRest = 0,
  storageKey,
  label,
  paneId: providedPaneId,
  paneRef,
  onSizeCommit,
}: UseResizablePaneOptions): UseResizablePaneResult {
  const generatedPaneId = useId();
  const paneId = providedPaneId ?? generatedPaneId;
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startSize: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [size, setSize] = useState(
    () => readStoredSize(storageKey) ?? defaultSize,
  );
  const [containerSize, setContainerSize] = useState(0);

  // Observed rather than read on window resize, because these containers
  // change width without one: the sidebar collapsing next to a split is the
  // common case. A stale bound would clamp a drag to the wrong place and make
  // the handle misreport how far it can still travel.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setContainerSize(container.offsetWidth);
    const observer = new ResizeObserver(() => {
      setContainerSize(container.offsetWidth);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // A container narrower than both panes' minimums makes the derived bound
  // fall below `minSize`; the pane's own minimum wins, and the layout
  // overflows rather than collapsing the pane past what it can render.
  const effectiveMax = Math.max(
    minSize,
    Math.min(
      maxSize ?? Number.POSITIVE_INFINITY,
      containerSize > 0
        ? containerSize - reserveForRest
        : Number.POSITIVE_INFINITY,
    ),
  );
  const clamp = useCallback(
    (next: number) => Math.max(minSize, Math.min(next, effectiveMax)),
    [minSize, effectiveMax],
  );

  // Before the first measurement, and with no absolute `maxSize`, the bound is
  // genuinely unknown. `End` must still land somewhere real and the separator
  // must still announce a number, so the size in use stands in until a
  // measurement arrives.
  const boundedMax = Number.isFinite(effectiveMax)
    ? effectiveMax
    : Math.max(minSize, size);

  // Re-clamp when the bound moves so a pane sized for a wide window does not
  // keep its width after the window shrinks under it.
  useEffect(() => {
    setSize((prev) => {
      const clamped = clamp(prev);
      if (clamped !== prev && paneRef?.current) {
        paneRef.current.style.width = `${clamped}px`;
      }
      return clamped;
    });
  }, [clamp, paneRef]);

  /** Px the pane grows by when the handle travels `dx` to the right. */
  const paneDelta = useCallback(
    (dx: number) => (side === "end" ? -dx : dx),
    [side],
  );

  const applyLive = useCallback(
    (next: number) => {
      if (paneRef?.current) {
        paneRef.current.style.width = `${next}px`;
        return;
      }
      setSize(next);
    },
    [paneRef],
  );

  const commit = useCallback(
    (next: number) => {
      setSize(next);
      writeStoredSize(storageKey, next);
      onSizeCommit?.(next);
    },
    [storageKey, onSizeCommit],
  );

  // Held on `document.body` for the drag's duration so the cursor does not
  // flicker back to a text caret whenever the pointer crosses content while
  // the handle still has capture.
  const setBodyDragStyles = useCallback((active: boolean) => {
    if (typeof document === "undefined") return;
    document.body.style.cursor = active ? "col-resize" : "";
    document.body.style.userSelect = active ? "none" : "";
  }, []);

  // A drag interrupted by unmount (a route change mid-drag) would otherwise
  // leave the whole page stuck with a resize cursor and no selection.
  useEffect(() => () => setBodyDragStyles(false), [setBodyDragStyles]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startSize: size };
      setIsResizing(true);
      setBodyDragStyles(true);
    },
    [size, setBodyDragStyles],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      applyLive(clamp(drag.startSize + paneDelta(e.clientX - drag.startX)));
    },
    [applyLive, clamp, paneDelta],
  );

  const endDrag = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      dragRef.current = null;
      setIsResizing(false);
      setBodyDragStyles(false);
      commit(clamp(drag.startSize + paneDelta(e.clientX - drag.startX)));
    },
    [commit, clamp, paneDelta, setBodyDragStyles],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const nudge = e.shiftKey ? STEP_PX * COARSE_STEP_MULTIPLIER : STEP_PX;
      let next: number;
      switch (e.key) {
        case "ArrowLeft":
          next = size + paneDelta(-nudge);
          break;
        case "ArrowRight":
          next = size + paneDelta(nudge);
          break;
        case "Home":
          next = minSize;
          break;
        case "End":
          next = boundedMax;
          break;
        default:
          return;
      }
      // Claim the key before the browser scrolls the pane behind the handle.
      e.preventDefault();
      // No `applyLive` here: a key press has no per-frame budget problem, so
      // the commit's own re-render is what moves the pane.
      commit(clamp(next));
    },
    [size, paneDelta, minSize, boundedMax, clamp, commit],
  );

  return {
    size,
    containerRef,
    paneId,
    isResizing,
    handleProps: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": label,
      "aria-controls": paneId,
      "aria-valuenow": Math.round(size),
      "aria-valuemin": Math.round(minSize),
      "aria-valuemax": Math.round(boundedMax),
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown,
    },
  };
}
