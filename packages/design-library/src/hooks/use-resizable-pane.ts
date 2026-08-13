/**
 * One owner for "a pane has a width, the other side takes the rest, you can
 * drag or key the edge, and it is remembered".
 *
 * Four surfaces are that same thing: the sidebar rail, the app-editing split,
 * the Activity/Schedules detail drawer, and the tool-detail drawer. They share
 * the width state, the clamping, the persistence, and the pointer arithmetic.
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

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

/**
 * `useLayoutEffect` warns when React renders on the server, and this package is
 * rendered to static markup in its own tests. The migration it guards has
 * nothing to do before hydration anyway.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

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

/**
 * The upper bound the pane may take: its own hard cap, and whatever the
 * measured container leaves after reserving room for the other side. Returns
 * `Infinity` when neither bound is known yet.
 *
 * A container narrower than both panes' minimums drives the derived bound
 * below `minSize`; the pane's own minimum wins there, and the layout overflows
 * rather than collapsing the pane past what it can render.
 */
export function resolveMaxSize({
  minSize,
  maxSize,
  reserveForRest,
  containerSize,
}: {
  minSize: number;
  maxSize?: number;
  reserveForRest: number;
  containerSize: number;
}): number {
  return Math.max(
    minSize,
    Math.min(
      maxSize ?? Number.POSITIVE_INFINITY,
      containerSize > 0
        ? containerSize - reserveForRest
        : Number.POSITIVE_INFINITY,
    ),
  );
}

/**
 * The same bound reduced to a real number, for the two places that cannot use
 * `Infinity`: what `End` commits, and what the separator announces.
 */
export function boundedMaxSize(
  maxSize: number,
  minSize: number,
  size: number,
): number {
  return Number.isFinite(maxSize) ? maxSize : Math.max(minSize, size);
}

export function clampSize(
  next: number,
  minSize: number,
  maxSize: number,
): number {
  return Math.max(minSize, Math.min(next, maxSize));
}

/** Px the pane grows by when the handle travels `dx` to the right. */
export function paneDelta(dx: number, side: "start" | "end"): number {
  return side === "end" ? -dx : dx;
}

/**
 * The size a value in an older format becomes, converted against the container
 * it is being restored into and held inside that container's current bounds.
 *
 * The clamp is what keeps the migration honest. A split that was valid in a
 * wide window can convert to a width the current window cannot give, and the
 * migrated number is written to storage, so an unclamped result would persist
 * a size the pane can never take. The passive re-clamp corrects the render but
 * deliberately does not rewrite storage, which is what lets a width survive a
 * temporary narrowing, so the value has to be valid before it is stored.
 */
export function migrateLegacySize({
  stored,
  containerSize,
  convert,
  minSize,
  maxSize,
  reserveForRest,
}: {
  stored: number;
  containerSize: number;
  convert: (stored: number, containerSize: number) => number;
  minSize: number;
  maxSize?: number;
  reserveForRest: number;
}): number | null {
  const converted = Math.round(convert(stored, containerSize));
  if (!Number.isFinite(converted)) return null;
  return clampSize(
    converted,
    minSize,
    resolveMaxSize({ minSize, maxSize, reserveForRest, containerSize }),
  );
}

/**
 * The size a key press asks for, or `null` for a key this pattern does not
 * claim. `Enter` is deliberately unclaimed: APG lists collapse and restore as
 * conditional on the implementation supporting collapse, and no pane here can
 * collapse.
 */
export function nextSizeForKey(
  key: string,
  {
    shiftKey,
    size,
    side,
    minSize,
    maxSize,
  }: {
    shiftKey: boolean;
    size: number;
    side: "start" | "end";
    minSize: number;
    maxSize: number;
  },
): number | null {
  const nudge = shiftKey ? STEP_PX * COARSE_STEP_MULTIPLIER : STEP_PX;
  switch (key) {
    case "ArrowLeft":
      return size + paneDelta(-nudge, side);
    case "ArrowRight":
      return size + paneDelta(nudge, side);
    case "Home":
      return minSize;
    case "End":
      return maxSize;
    default:
      return null;
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
  /**
   * A key holding a size in an older format, migrated into `storageKey` once
   * the container has been measured and then removed. `convert` receives the
   * stored value and the measured container size and returns the equivalent
   * in the current format.
   */
  legacySize?: {
    key: string;
    convert: (stored: number, containerSize: number) => number;
  };
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
  /**
   * Measured width of the container element, 0 until the first measure lands.
   * Lets a caller that renders the pane itself (no `paneRef`) cap the drawn
   * width when the container is narrower than `size` can clamp to, instead of
   * overflowing (see `resolveMaxSize`).
   */
  containerSize: number;
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
  legacySize,
  label,
  paneId: providedPaneId,
  paneRef,
  onSizeCommit,
}: UseResizablePaneOptions): UseResizablePaneResult {
  // Held in a ref so the migration effect can depend on the key alone. A
  // caller passing an inline object would otherwise re-run it every render.
  const legacySizeRef = useRef(legacySize);
  legacySizeRef.current = legacySize;

  const generatedPaneId = useId();
  const paneId = providedPaneId ?? generatedPaneId;
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startSize: number } | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  // `minSize` is applied at read time so a stale or corrupt stored value never
  // renders below the minimum, not even for the frame before the re-clamp
  // effect runs. The upper bound needs a measured container, so it waits.
  const [size, setSize] = useState(() =>
    Math.max(minSize, readStoredSize(storageKey) ?? defaultSize),
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

  const effectiveMax = resolveMaxSize({
    minSize,
    maxSize,
    reserveForRest,
    containerSize,
  });
  const clamp = useCallback(
    (next: number) => clampSize(next, minSize, effectiveMax),
    [minSize, effectiveMax],
  );
  const boundedMax = boundedMaxSize(effectiveMax, minSize, size);

  // Runs before paint so a converted size never flashes the default. The
  // synchronous read is what makes that possible, since `containerSize` is
  // still 0 on the first pass; depending on it as well retries the conversion
  // for a container that had no layout at mount, which is what a hidden tab or
  // an offscreen route looks like. Without the retry a stored value would stay
  // stranded in the old format.
  const legacyKey = legacySize?.key;
  useIsomorphicLayoutEffect(() => {
    const legacy = legacySizeRef.current;
    if (!legacy || !storageKey) return;
    if (readStoredSize(storageKey) != null) return;
    const stored = readStoredSize(legacy.key);
    if (stored == null) return;
    const containerWidth = containerRef.current?.offsetWidth || containerSize;
    if (containerWidth <= 0) return;
    // Bounds come from the width just measured rather than from `clamp`, whose
    // `containerSize` is still 0 on the synchronous first pass.
    const converted = migrateLegacySize({
      stored,
      containerSize: containerWidth,
      convert: legacy.convert,
      minSize,
      maxSize,
      reserveForRest,
    });
    if (converted == null) return;
    setSize(converted);
    writeStoredSize(storageKey, converted);
    try {
      localStorage.removeItem(legacy.key);
    } catch {
      // Storage quota or security error, ignore.
    }
  }, [legacyKey, storageKey, containerSize, minSize, maxSize, reserveForRest]);

  // Re-clamp when the bound moves so a pane sized for a wide window does not
  // keep its width after the window shrinks under it. The DOM write stays out
  // of the state updater, which React is free to call more than once.
  useEffect(() => {
    const clamped = clamp(size);
    if (clamped === size) return;
    setSize(clamped);
    if (paneRef?.current) {
      paneRef.current.style.width = `${clamped}px`;
    }
  }, [size, clamp, paneRef]);

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

  // Rounded once, here, so the state, the persisted entry, the caller's
  // callback, and the separator's `aria-valuenow` all carry the same number. A
  // sub-pixel container measurement otherwise reaches storage verbatim and
  // disagrees with what the separator announces.
  const commit = useCallback(
    (next: number) => {
      const rounded = Math.round(next);
      setSize(rounded);
      writeStoredSize(storageKey, rounded);
      onSizeCommit?.(rounded);
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
      applyLive(
        clamp(drag.startSize + paneDelta(e.clientX - drag.startX, side)),
      );
    },
    [applyLive, clamp, side],
  );

  const endDrag = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      dragRef.current = null;
      setIsResizing(false);
      setBodyDragStyles(false);
      commit(clamp(drag.startSize + paneDelta(e.clientX - drag.startX, side)));
    },
    [commit, clamp, side, setBodyDragStyles],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const next = nextSizeForKey(e.key, {
        shiftKey: e.shiftKey,
        size,
        side,
        minSize,
        maxSize: boundedMax,
      });
      if (next == null) return;
      // Claim the key before the browser scrolls the pane behind the handle.
      e.preventDefault();
      // No `applyLive` here: a key press has no per-frame budget problem, so
      // the commit's own re-render is what moves the pane.
      commit(clamp(next));
    },
    [size, side, minSize, boundedMax, clamp, commit],
  );

  return {
    size,
    containerSize,
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
