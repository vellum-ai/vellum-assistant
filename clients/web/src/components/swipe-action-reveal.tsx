import { type ComponentPropsWithoutRef, forwardRef } from "react";

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

/** What an action paints, keyed by its variant. */
const ACTION_SURFACE = {
  default: { bg: "var(--primary-base)", fg: "var(--content-inset)" },
  destructive: { bg: "var(--system-negative-strong)", fg: "var(--aux-white)" },
} as const;

function surfaceFor(action: SwipeAction) {
  return ACTION_SURFACE[action.variant ?? "default"];
}

function SwipeActionButton({
  action,
  onAfterSelect,
}: {
  action: SwipeAction;
  onAfterSelect: () => void;
}) {
  const Icon = action.icon;
  const surface = surfaceFor(action);

  return (
    <button
      type="button"
      aria-label={action.label}
      onClick={() => {
        action.onSelect();
        onAfterSelect();
      }}
      className={cn(
        "flex shrink-0 flex-col items-center justify-center gap-1",
        "touch-mobile:transition-none",
      )}
      style={{
        width: ACTION_WIDTH_PX,
        color: surface.fg,
        background: surface.bg,
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
// Action layer
// ---------------------------------------------------------------------------

/**
 * One side's actions, as a layer the whole size and shape of the item, behind
 * it. The buttons sit at the edge the layer belongs to, so what the item
 * uncovers as it slides is the layer's own end, rounded like the item.
 *
 * Painted in the outermost action's colour, so an overdrag past the buttons
 * shows the layer's surface rather than the box behind it.
 *
 * Both layers fill the box, so the one on the side not being swiped is hidden
 * or it would paint over the other. The layer on the swiped side stays
 * painted whenever the item is off centre, including while it slides back to
 * rest: hiding it the moment the offset reads zero would blink the box behind
 * it for the length of that transition. At rest the item covers it, and
 * `inert` and `aria-hidden` keep its buttons out of the tab path and the
 * accessibility tree while covered.
 */
function ActionLayer({
  side,
  actions,
  offset,
  onAfterSelect,
}: {
  side: "leading" | "trailing";
  actions: SwipeAction[];
  offset: number;
  onAfterSelect: () => void;
}) {
  const outermost =
    side === "trailing" ? actions[actions.length - 1]! : actions[0]!;
  const wrongSide = side === "trailing" ? offset > 0 : offset < 0;
  const covered = offset === 0;
  return (
    <div
      className={cn(
        "absolute inset-0 flex overflow-hidden rounded-[inherit]",
        side === "trailing" ? "justify-end" : "justify-start",
      )}
      inert={covered}
      aria-hidden={covered}
      style={{
        background: surfaceFor(outermost).bg,
        visibility: wrongSide ? "hidden" : "visible",
      }}
    >
      {actions.map((action) => (
        <SwipeActionButton
          key={action.id}
          action={action}
          onAfterSelect={onAfterSelect}
        />
      ))}
    </div>
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
 * Reveals action buttons behind an item as the user swipes it horizontally.
 * On touch, swiping left reveals `trailingActions` (Archive, Unpin), swiping
 * right reveals `leadingActions` (Pin). Releasing past the commit threshold
 * snaps to the revealed state; below it snaps back. On a fine pointer this is
 * a passthrough: the children render with no swipe affordance.
 *
 * Two layers in the item's box and shape, the way a list cell is built. Each
 * side's actions are a layer the whole size of the box, behind; the item is
 * the layer on top and slides toward the swiped edge in a `translateX()`. The
 * item has to paint its own surface, since that is what covers the action
 * layer at rest: a pill does already, and a row on a card paints the card's
 * colour so it reads as transparent until it moves. The root takes the
 * caller's shape (`w-fit rounded-full` for a pill; the row's width and radius
 * by default), and the layers inherit its radius.
 *
 * Nothing here clips the item. The surface that has an edge clips at that
 * edge, the way a list clips the cell sliding inside it: a section card sets
 * `clipContents`, and the drawer's own edge does the rest.
 *
 * Modeled on the swipe patterns in {@link use-gallery-swipe} and
 * {@link use-edge-swipe}. Action colours follow the iOS Mail convention:
 * destructive actions in red, others in the primary colour.
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

  return (
    <div
      ref={ref}
      // `relative` so the action layers position against the row; the
      // caller's classes give it its shape, which the layers inherit.
      className={cn("relative", className)}
      // Spread injected props first so our swipe-specific touch handlers
      // take precedence if there is ever a key collision.
      {...rest}
      // Marks a row that owns horizontal drags, so an enclosing panel gesture
      // (the mobile drawer's swipe-to-close) stands down over it. Only the
      // armed branch carries it: with no actions there is nothing to yield to.
      //
      // Its own attribute, declared after the injected props, because a parent
      // using `asChild` hands the row a `data-slot` of its own: a mark a
      // gesture depends on has to be one a wrapper cannot overwrite.
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
      {trailingActions && trailingActions.length > 0 ? (
        <ActionLayer
          side="trailing"
          actions={trailingActions}
          offset={offset}
          onAfterSelect={close}
        />
      ) : null}
      {leadingActions && leadingActions.length > 0 ? (
        <ActionLayer
          side="leading"
          actions={leadingActions}
          offset={offset}
          onAfterSelect={close}
        />
      ) : null}
      <div
        className={cn(
          "relative rounded-[inherit] transition-transform",
          isDragging && "transition-none",
        )}
        style={{ transform: `translateX(${offset}px)` }}
      >
        {children}
      </div>
    </div>
  );
});
