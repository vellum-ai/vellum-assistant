import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cn } from "../utils/cn";
import { SplitterHandle } from "./splitter-handle";

/**
 * Width of the drag-handle column between the two panes. Must match the
 * Tailwind `w-2` class on the separator element below (0.5rem = 8px under
 * the default rem). Subtracted from container width when resolving a
 * `defaultRightWidth` so the right pane ends up at exactly that size.
 */
const SEPARATOR_WIDTH_PX = 8;

/**
 * Read a persisted pixel width from localStorage, validating both shape
 * and finiteness. Returns `null` for unset/malformed entries or when
 * storage access throws (strict-privacy contexts, quota errors, SSR).
 */
function readStoredWidth(
  storageKey: string | undefined,
  minLeftWidth: number,
): number | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored == null) return null;
    const parsed = Number(stored);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(minLeftWidth, parsed);
  } catch {
    return null;
  }
}

export interface ResizablePanelProps
  extends Omit<ComponentProps<"div">, "children"> {
  /** Content for the left pane. */
  left: ReactNode;
  /** Content for the right pane. */
  right: ReactNode;
  /** Initial width of the left pane in px (default 400). */
  defaultLeftWidth?: number;
  /** Initial width of the left pane as a percentage of the container (0–100). Resolved via useLayoutEffect on mount. */
  defaultLeftPercent?: number;
  /**
   * Initial width of the *right* pane in px. When set, the left pane is sized
   * to fill the rest of the container on first open, so the right pane stays
   * at a bounded size regardless of window width. Resolved via useLayoutEffect
   * on mount. Ignored when `defaultLeftPercent` is also set (percent wins).
   */
  defaultRightWidth?: number;
  /** Minimum left pane width in px (default 300). */
  minLeftWidth?: number;
  /** Minimum right pane width in px (default 300). */
  minRightWidth?: number;
  /** Callback fired when the left pane width changes, by drag or by key. */
  onWidthChange?: (leftWidth: number) => void;
  /**
   * Accessible name for the drag separator (default "Resize panels"). Set it
   * when a page has more than one split so the two are told apart.
   */
  separatorLabel?: string;
  /** Optional localStorage key for persisting the left pane width across reloads. */
  storageKey?: string;
  /**
   * Hide the always-visible 1px divider line between the panes while keeping
   * the full drag hit-area and the hover grab handle. Useful when the right
   * pane already has its own container chrome (e.g. a rounded detail drawer)
   * and the separator line reads as a redundant extra border.
   */
  hideDivider?: boolean;
}

/**
 * Horizontal split-view with a draggable divider.
 *
 * Uses pointer events with `setPointerCapture` for reliable cross-browser
 * drag tracking. No external resizable library is used.
 */
export function ResizablePanel({
  left,
  right,
  defaultLeftWidth = 400,
  defaultLeftPercent,
  defaultRightWidth,
  minLeftWidth = 300,
  minRightWidth = 300,
  onWidthChange,
  separatorLabel = "Resize panels",
  storageKey,
  hideDivider = false,
  className,
  ...rest
}: ResizablePanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const leftPaneId = useId();

  const [leftWidth, setLeftWidth] = useState<number>(
    () => readStoredWidth(storageKey, minLeftWidth) ?? defaultLeftWidth,
  );

  const [isDragging, setIsDragging] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);

  const clamp = useCallback(
    (width: number) => {
      const container = containerRef.current;
      // Unmeasured container (offsetWidth 0): keep the requested width instead
      // of collapsing to the minimum on a negative max.
      if (!container || container.offsetWidth <= 0) return width;
      const maxLeft = container.offsetWidth - minRightWidth;
      return Math.max(minLeftWidth, Math.min(width, maxLeft));
    },
    [minLeftWidth, minRightWidth],
  );

  const handleValueChange = useCallback(
    (next: number) => {
      const width = clamp(next);
      setLeftWidth(width);
      onWidthChange?.(width);
    },
    [clamp, onWidthChange],
  );

  const handleValueCommit = useCallback(
    (next: number) => {
      if (!storageKey) return;
      try {
        localStorage.setItem(storageKey, String(clamp(next)));
      } catch {
        // Storage quota or security error, ignore.
      }
    },
    [clamp, storageKey],
  );

  useEffect(() => {
    setLeftWidth((prev) => clamp(prev));

    function onResize() {
      setLeftWidth((prev) => clamp(prev));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  // Backs `aria-valuemax` only; `clamp` above still measures live on each
  // change. Observed rather than read on window resize because this container
  // changes width without one (the sidebar collapsing beside it, say), and a
  // stale maximum would misreport how far the pane can still travel.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setContainerWidth(container.offsetWidth);
    const observer = new ResizeObserver(() => {
      setContainerWidth(container.offsetWidth);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Resolve the on-mount width before paint when no valid persisted
  // preference exists. Runs in useLayoutEffect so the resolved width is
  // committed before the browser paints, preventing a single-frame flash
  // of the `defaultLeftWidth` pixel fallback.
  //
  // Precedence: `defaultLeftPercent` > `defaultRightWidth` > `defaultLeftWidth`
  // (whose value already seeds the initial useState above, so the no-prop
  // branch is a no-op here).
  useLayoutEffect(() => {
    if (readStoredWidth(storageKey, minLeftWidth) !== null) return;
    const container = containerRef.current;
    if (!container) return;
    const containerWidth = container.offsetWidth;
    if (containerWidth <= 0) return;
    let target: number | null = null;
    if (defaultLeftPercent != null) {
      target = (containerWidth * defaultLeftPercent) / 100;
    } else if (defaultRightWidth != null) {
      target = containerWidth - defaultRightWidth - SEPARATOR_WIDTH_PX;
    }
    if (target == null) return;
    setLeftWidth(clamp(target));
  }, [defaultLeftPercent, defaultRightWidth, storageKey, minLeftWidth, clamp]);

  // Before the first measurement the container width is unknown, so the only
  // honest upper bound is the width already in use.
  const maxLeftWidth =
    containerWidth > 0
      ? Math.max(minLeftWidth, containerWidth - minRightWidth)
      : Math.max(minLeftWidth, leftWidth);

  return (
    <div
      {...rest}
      ref={containerRef}
      data-slot="resizable-panel"
      className={cn("flex h-full w-full overflow-hidden", className)}
    >
      <div
        id={leftPaneId}
        className="flex h-full shrink-0 flex-col overflow-hidden"
        style={{ width: leftWidth }}
      >
        {left}
      </div>

      <SplitterHandle
        value={leftWidth}
        min={minLeftWidth}
        max={maxLeftWidth}
        onValueChange={handleValueChange}
        onValueCommit={handleValueCommit}
        onResizeStart={() => setIsDragging(true)}
        onResizeEnd={() => setIsDragging(false)}
        label={separatorLabel}
        controls={leftPaneId}
        className={cn(
          "group relative z-10 flex h-full w-2 shrink-0 items-center justify-center",
          isDragging && "select-none",
        )}
      >
        <div
          className={cn(
            "h-full w-px",
            hideDivider ? "bg-transparent" : "bg-[var(--border-base)]",
          )}
        />
        <div
          className={cn(
            "absolute h-8 w-1 rounded-full bg-[var(--content-tertiary)] opacity-0 transition-opacity",
            "group-hover:opacity-100 group-focus-visible:opacity-100",
            isDragging && "opacity-100",
          )}
        />
      </SplitterHandle>

      <div className="h-full min-w-0 flex-1 overflow-auto">{right}</div>
    </div>
  );
}
