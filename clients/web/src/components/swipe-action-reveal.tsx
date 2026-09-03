import { type ComponentPropsWithoutRef, forwardRef, useCallback } from "react";

import { cn } from "@vellumai/design-library/utils/cn";

import {
  ACTION_WIDTH_PX,
  type SwipeAction,
  useSwipeToReveal,
} from "@/hooks/use-swipe-to-reveal";
import { isPointerCoarse } from "@/utils/pointer";

// ---------------------------------------------------------------------------
// Action button
// ---------------------------------------------------------------------------

function SwipeActionButton({
  action,
  onAfterSelect,
  hidden = false,
}: {
  action: SwipeAction;
  onAfterSelect: () => void;
  hidden?: boolean;
}) {
  const handleClick = useCallback(() => {
    action.onSelect();
    onAfterSelect();
  }, [action, onAfterSelect]);

  const Icon = action.icon;

  return (
    <button
      type="button"
      aria-label={action.label}
      aria-hidden={hidden}
      tabIndex={hidden ? -1 : 0}
      onClick={handleClick}
      className={cn(
        "flex shrink-0 flex-col items-center justify-center gap-1",
        "touch-mobile:transition-none",
      )}
      style={{
        width: ACTION_WIDTH_PX,
        color:
          action.variant === "destructive"
            ? "var(--aux-white)"
            : "var(--content-inset)",
        background:
          action.variant === "destructive"
            ? "var(--system-negative-strong)"
            : "var(--primary-base)",
      }}
    >
      <Icon size={18} />
      <span className="text-[10px] font-medium leading-none">
        {action.label}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SwipeActionReveal
// ---------------------------------------------------------------------------

export interface SwipeActionRevealProps extends ComponentPropsWithoutRef<"div"> {
  /** Actions revealed on swipe-right (leading / left side). */
  leadingActions?: SwipeAction[];
  /** Actions revealed on swipe-left (trailing / right side). */
  trailingActions?: SwipeAction[];
  /** Whether swipe is enabled. Defaults to `isPointerCoarse()`. */
  enabled?: boolean;
}

/**
 * Wraps a list-row content layer and reveals action buttons behind it as the
 * user swipes horizontally. On touch devices, swiping left reveals trailing
 * actions (e.g. Archive), swiping right reveals leading actions (e.g. Pin).
 * Releasing past the commit threshold snaps to reveal; below it snaps back.
 *
 * On desktop (fine pointer), this is a passthrough — children render normally
 * with no swipe affordance.
 *
 * The content layer sits in a `transform: translateX()` beside two absolutely
 * positioned action layers. Each action layer is translated by its own width
 * away from the edge it hangs off, so at rest it sits wholly outside the layer
 * box and `overflow: hidden` clips it. A swipe walks that translation back in
 * step with the content, so an action is visible exactly across the strip the
 * content has vacated and never anywhere else.
 *
 * Which is why the content layer paints nothing of its own. Nothing here
 * depends on it covering an action, so a row carries whatever surface its own
 * content carries, in whatever shape: a `w-fit` pill reads as a pill rather
 * than as a pill sitting on a row-width fill.
 *
 * That clip lives one level inside the root rather than on it, because the
 * root is what a list lays out: a flex or grid item whose overflow is not
 * `visible` has its automatic minimum size resolved to zero instead of to its
 * content, so a clipping root can be squashed to nothing by a container that
 * is out of room. Keeping the clip off the root leaves a swipe row sizing
 * exactly like a row without one, in either axis and whatever the container.
 *
 * Modeled on the swipe patterns in {@link use-gallery-swipe} and
 * {@link use-edge-swipe}. Action button styling follows the iOS Mail
 * convention: trailing destructive actions in red, leading actions in
 * primary color.
 *
 * Forwards `ref` and any extra DOM props (e.g. `onContextMenu` injected by
 * Radix `ContextMenu.Trigger` with `asChild`) to the root element so parent
 * components that use `asChild` can attach handlers in both the swipe and
 * passthrough branches.
 */
export const SwipeActionReveal = forwardRef<
  HTMLDivElement,
  SwipeActionRevealProps
>(function SwipeActionReveal(
  {
    children,
    leadingActions,
    trailingActions,
    enabled = isPointerCoarse(),
    className,
    style,
    ...rest
  },
  ref,
) {
  const hasActions =
    enabled &&
    ((leadingActions?.length ?? 0) > 0 || (trailingActions?.length ?? 0) > 0);

  const {
    offset,
    isDragging,
    leadingWidth,
    trailingWidth,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
    close,
  } = useSwipeToReveal({
    enabled: hasActions,
    leadingActions,
    trailingActions,
  });

  if (!hasActions) {
    // Return a real DOM element — not a Fragment — so parents using
    // `asChild` (e.g. Radix ContextMenu.Trigger) can clone and attach
    // handlers to it.  Spread `rest` (which includes `onContextMenu`,
    // `ref`, etc. injected by the trigger) and forward `ref` so the
    // context menu works on fine-pointer desktop.
    return (
      <div ref={ref} className={className} style={style} {...rest}>
        {children}
      </div>
    );
  }

  /* How far each action layer stands outside the box it hangs off: its own
     width at rest, closing to zero as the content vacates the strip it needs.
     Clamped at zero so an overdrag past the reveal width slides the content
     on alone rather than dragging the actions out of the far edge with it. */
  const trailingShift = Math.max(0, trailingWidth + offset);
  const leadingShift = Math.min(0, offset - leadingWidth);

  /* The action layers travel with the content, so they share its transition:
     the release animates all three to the committed position together, and a
     live drag pins every one of them to the finger. */
  const layerTransition = cn(
    "transition-transform",
    isDragging && "transition-none",
  );

  return (
    <div
      ref={ref}
      className={className}
      // Spread injected props first so our swipe-specific touch handlers
      // take precedence if there is ever a key collision.
      {...rest}
      // Marks a row that owns horizontal drags, so an enclosing panel gesture
      // can stand down over it. The mobile drawer's swipe-to-close reads this
      // to leave a row's own swipe actions alone. Only the armed branch carries
      // it: with no actions there is nothing to yield to.
      //
      // An attribute of its own rather than a `data-slot`, declared after the
      // injected props: a parent using `asChild` hands the row a `data-slot`
      // of its own (the pinned-app pill's `ContextMenu.Trigger` does), and a
      // mark a gesture depends on has to be one a wrapper cannot overwrite.
      data-swipe-action-row=""
      // Allow vertical scrolling to remain native while claiming horizontal
      // gestures for swipe-to-reveal, preventing the browser from
      // intercepting them for edge navigation / native panning.
      style={{ ...style, touchAction: "pan-y" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {/* The layer box. `rounded-[inherit]` takes whatever radius the caller
          put on the root, so a revealed action is cut to the row's corners.
          This is also the clip that parks the action layers outside the row
          until a swipe walks them in. */}
      <div className="relative overflow-hidden rounded-[inherit]">
        {/* Trailing actions (right side, revealed on swipe-left) */}
        {trailingActions && trailingActions.length > 0 ? (
          <div
            className={cn("absolute inset-y-0 right-0 flex", layerTransition)}
            aria-hidden={offset >= 0}
            style={{
              transform: `translateX(${trailingShift}px)`,
              // Remove hidden actions from tab order: they're only reachable
              // after a swipe reveals them. Without this, tab navigation
              // lands on buttons parked outside the clip.
              pointerEvents: offset >= 0 ? "none" : undefined,
            }}
          >
            {trailingActions.map((action) => (
              <SwipeActionButton
                key={action.id}
                action={action}
                onAfterSelect={close}
                hidden={offset >= 0}
              />
            ))}
          </div>
        ) : null}

        {/* Leading actions (left side, revealed on swipe-right) */}
        {leadingActions && leadingActions.length > 0 ? (
          <div
            className={cn("absolute inset-y-0 left-0 flex", layerTransition)}
            aria-hidden={offset <= 0}
            style={{
              transform: `translateX(${leadingShift}px)`,
              pointerEvents: offset <= 0 ? "none" : undefined,
            }}
          >
            {leadingActions.map((action) => (
              <SwipeActionButton
                key={action.id}
                action={action}
                onAfterSelect={close}
                hidden={offset <= 0}
              />
            ))}
          </div>
        ) : null}

        {/* Content layer, sliding aside to admit the action layers. It paints
            no fill of its own: the row keeps whatever surface it has on the
            page, of whatever shape, because nothing here depends on it
            covering anything. */}
        <div
          className={cn("relative", layerTransition)}
          style={{ transform: `translateX(${offset}px)` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
});
