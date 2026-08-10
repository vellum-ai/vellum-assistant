import {
  useCallback,
  useRef,
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { cn } from "../utils/cn";

/**
 * Default keyboard nudge in px for a single arrow press, and the coarse step
 * used when Shift is held. A split pane's useful range is hundreds of pixels
 * wide, so a 1px arrow step would be unusable; 16 matches the app's spacing
 * scale and 64 crosses the range in a sensible number of presses.
 */
const DEFAULT_STEP_PX = 16;
const COARSE_STEP_MULTIPLIER = 4;

export interface SplitterHandleProps
  extends Omit<
    ComponentProps<"div">,
    | "role"
    | "tabIndex"
    | "onKeyDown"
    | "children"
    | "aria-label"
    // The handle owns the pointer sequence end to end, including capture. A
    // caller-supplied handler would either be overwritten or silently split
    // the drag across two owners, so the props are removed rather than merged.
    | "onPointerDown"
    | "onPointerMove"
    | "onPointerUp"
    | "onPointerCancel"
  > {
  /**
   * Current size in px of the pane this handle controls, reported as
   * `aria-valuenow`. The handle is controlled: it never holds the size
   * itself, so each caller keeps its own clamping and persistence.
   */
  value: number;
  /** Smallest size the controlled pane may take, in px. */
  min: number;
  /** Largest size the controlled pane may take, in px. */
  max: number;
  /**
   * Called with the requested new size on every drag frame and every key
   * press. The value is **not** clamped: `min`/`max` are what the handle
   * announces, but the caller is the one that can measure its container at
   * the moment of the change, so the caller owns clamping. A handle that
   * clamped against its own props would freeze the pane whenever those props
   * were computed from a stale measurement.
   */
  onValueChange: (next: number) => void;
  /**
   * Called once with the final size when a drag or key press finishes. This
   * is the hook for persisting a width. Omit when there is nothing to commit.
   */
  onValueCommit?: (next: number) => void;
  /** Accessible name, e.g. "Resize sidebar". Required: an unnamed splitter announces as a bare separator. */
  label: string;
  /** `id` of the pane this handle resizes, for `aria-controls`. */
  controls?: string;
  /**
   * Set when moving the handle to the right *shrinks* the controlled pane.
   * True for a right-hand drawer, whose size grows as the handle travels
   * left. Arrow keys follow the handle, not the pane, so ArrowRight always
   * moves the divider rightward on screen.
   */
  invert?: boolean;
  /** Px moved per arrow press (default 16). Shift multiplies it by 4. */
  step?: number;
  /**
   * Called when a pointer drag begins, for callers that suspend a transition
   * or set a body cursor for its duration. Named `onResize*` rather than
   * `onDrag*` so it does not shadow the native HTML drag events, which stay
   * available on this element.
   */
  onResizeStart?: () => void;
  /** Called when a pointer drag ends, after `onValueCommit`. */
  onResizeEnd?: () => void;
  /** Visual content: the divider line and grab affordance. */
  children?: ReactNode;
}

/**
 * The interactive divider between two panes, implementing the APG window
 * splitter pattern: a focusable `role="separator"` that reports its position
 * and moves with the arrow keys.
 *
 * Exists because three splitters in this codebase each hand-rolled a
 * pointer-only divider (LUM-3194). `role="separator"` is a widget role only
 * when the element is focusable ([ARIA 1.2][aria-separator]); a divider that
 * declares the role without `tabindex` announces as decorative page furniture
 * while being the only control over the pane's size.
 *
 * `Enter` (collapse/restore the primary pane) is deliberately absent. APG
 * lists it as conditional on the implementation supporting collapse, and no
 * caller here can collapse a pane: all three clamp to a non-zero minimum.
 *
 * Presentation belongs to the caller: pass the divider line and grab handle as
 * `children` and size the hit area with `className`.
 *
 * [aria-separator]: https://www.w3.org/TR/wai-aria-1.2/#separator
 * @see https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/
 */
export function SplitterHandle({
  value,
  min,
  max,
  onValueChange,
  onValueCommit,
  label,
  controls,
  invert = false,
  step = DEFAULT_STEP_PX,
  onResizeStart,
  onResizeEnd,
  className,
  children,
  ...rest
}: SplitterHandleProps) {
  const dragRef = useRef<{ startX: number; startValue: number } | null>(null);

  /** Signed px the controlled pane grows by when the handle travels `dx` right. */
  const paneDelta = useCallback((dx: number) => (invert ? -dx : dx), [invert]);

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startValue: value };
      onResizeStart?.();
    },
    [value, onResizeStart],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      onValueChange(drag.startValue + paneDelta(e.clientX - drag.startX));
    },
    [onValueChange, paneDelta],
  );

  const endDrag = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      dragRef.current = null;
      const final = drag.startValue + paneDelta(e.clientX - drag.startX);
      onValueChange(final);
      onValueCommit?.(final);
      onResizeEnd?.();
    },
    [paneDelta, onValueChange, onValueCommit, onResizeEnd],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const nudge = e.shiftKey ? step * COARSE_STEP_MULTIPLIER : step;
      let next: number;
      switch (e.key) {
        case "ArrowLeft":
          next = value + paneDelta(-nudge);
          break;
        case "ArrowRight":
          next = value + paneDelta(nudge);
          break;
        case "Home":
          next = min;
          break;
        case "End":
          next = max;
          break;
        default:
          return;
      }
      // Claim the key before the browser scrolls the pane behind the handle.
      e.preventDefault();
      onValueChange(next);
      onValueCommit?.(next);
    },
    [step, value, paneDelta, min, max, onValueChange, onValueCommit],
  );

  return (
    <div
      {...rest}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      data-slot="splitter-handle"
      className={cn(
        "cursor-col-resize",
        // A newly focusable control needs a visible focus indicator (WCAG
        // 2.4.7). The handle is a thin column, so a ring reads better than an
        // inset outline at that width.
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}
