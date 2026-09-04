import { type ComponentPropsWithoutRef, forwardRef, useState } from "react";

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
 * One side's actions, as a layer the whole size of the item's box, behind it.
 * The buttons sit at the edge the layer belongs to, so what the item uncovers
 * as it slides is the layer's own end, cut to the item's shape by the clip
 * box both sit in.
 *
 * Painted in the outermost action's colour, so an overdrag past the buttons
 * shows the layer's surface rather than the box behind it.
 *
 * Hidden whenever the item is not uncovering it: at rest, and on the side the
 * item is sliding away from. A layer painted under a resting item shows at
 * the item's edge, as a hairline around a rounded pill and as corners past a
 * rounded row; and both layers fill the box, so the one on the other side
 * would paint over the one being revealed. `visibility` rather than
 * unmounting, so the buttons keep their layout, and a hidden layer is out of
 * the tab path and the accessibility tree on its own.
 *
 * The layer stays until the item has slid back over it (`settling`): hiding
 * it the moment the offset reads zero would blink the box behind it for the
 * length of that transition.
 */
function ActionLayer({
  side,
  actions,
  offset,
  settling,
  onAfterSelect,
}: {
  side: "leading" | "trailing";
  actions: SwipeAction[];
  offset: number;
  settling: boolean;
  onAfterSelect: () => void;
}) {
  const outermost =
    side === "trailing" ? actions[actions.length - 1]! : actions[0]!;
  const wrongSide = side === "trailing" ? offset > 0 : offset < 0;
  const covered = offset === 0 && !settling;
  return (
    <div
      className={cn(
        "absolute inset-0 flex",
        side === "trailing" ? "justify-end" : "justify-start",
      )}
      style={{
        background: surfaceFor(outermost).bg,
        visibility: wrongSide || covered ? "hidden" : "visible",
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
 * layers show for the gesture and the slide back and are hidden at rest, the
 * way a list cell adds its action view for a swipe and removes it once the
 * cell has settled. The item has to paint its own surface, since that is what
 * covers the action layer as it slides: a pill does already, and a row on a
 * card paints the card's colour so it reads as transparent until it moves.
 * The root takes the caller's shape (`w-fit rounded-full` for a pill,
 * `rounded-[6px]` for a row).
 *
 * Both sit in a clip box the root's shape, so what slides past the item's
 * edge is cut there, rounded as the item is, the way a cell clips the content
 * sliding inside it. The clip is one box inside the root rather than on it:
 * the root is what a list lays out, and a flex or grid item that clips its
 * overflow gives up its content-sized minimum and can be squashed to nothing
 * by a container out of room.
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

  // True from the moment the offset returns to zero until the item's slide
  // back has ended, so the layer it is sliding over stays painted for the
  // length of the transition. Set during render rather than in an effect: an
  // effect runs after the paint that already hid the layer. A drag has no
  // transition, so an offset that reaches zero under the finger hides at once.
  const [settling, setSettling] = useState(false);
  const [lastOffset, setLastOffset] = useState(offset);
  if (offset !== lastOffset) {
    setLastOffset(offset);
    setSettling(offset === 0 && !isDragging);
  }
  // The item's only transition is its transform; one ending on a descendant
  // is not its slide.
  const onSlideSettled = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      setSettling(false);
    }
  };

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
      // caller's classes give it its shape, which the clip box inherits.
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
      <div className="relative overflow-hidden rounded-[inherit]">
        {trailingActions && trailingActions.length > 0 ? (
          <ActionLayer
            side="trailing"
            actions={trailingActions}
            offset={offset}
            settling={settling}
            onAfterSelect={close}
          />
        ) : null}
        {leadingActions && leadingActions.length > 0 ? (
          <ActionLayer
            side="leading"
            actions={leadingActions}
            offset={offset}
            settling={settling}
            onAfterSelect={close}
          />
        ) : null}
        <div
          className={cn(
            "relative transition-transform",
            isDragging && "transition-none",
          )}
          style={{ transform: `translateX(${offset}px)` }}
          onTransitionEnd={onSlideSettled}
          onTransitionCancel={onSlideSettled}
        >
          {children}
        </div>
      </div>
    </div>
  );
});
