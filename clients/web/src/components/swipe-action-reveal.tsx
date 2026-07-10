import { type ReactNode, useCallback } from "react";

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
        color: action.variant === "destructive" ? "var(--aux-white)" : "var(--content-inset)",
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

export interface SwipeActionRevealProps {
  /** The row content that slides to reveal actions. */
  children: ReactNode;
  /** Actions revealed on swipe-right (leading / left side). */
  leadingActions?: SwipeAction[];
  /** Actions revealed on swipe-left (trailing / right side). */
  trailingActions?: SwipeAction[];
  /** Whether swipe is enabled. Defaults to `isPointerCoarse()`. */
  enabled?: boolean;
  /** Additional className on the outer container. */
  className?: string;
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
 * The content layer sits in a `transform: translateX()` above two absolutely
 * positioned action layers. `overflow: hidden` on the container clips the
 * action layers so they're invisible until the content slides away.
 *
 * Modeled on the swipe patterns in {@link use-gallery-swipe} and
 * {@link use-edge-swipe}. Action button styling follows the iOS Mail
 * convention: trailing destructive actions in red, leading actions in
 * primary color.
 */
export function SwipeActionReveal({
  children,
  leadingActions,
  trailingActions,
  enabled = isPointerCoarse(),
  className,
}: SwipeActionRevealProps) {
  const hasActions =
    enabled && ((leadingActions?.length ?? 0) > 0 || (trailingActions?.length ?? 0) > 0);

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
    // handlers to it.
    return <div className={className}>{children}</div>;
  }

  return (
    <div
      className={cn("relative overflow-hidden", className)}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {/* Trailing actions (right side, revealed on swipe-left) */}
      {trailingActions && trailingActions.length > 0 ? (
        <div
          className="absolute inset-y-0 right-0 flex"
          aria-hidden={offset >= 0}
          // Remove hidden actions from tab order — they're only reachable
          // after a swipe reveals them. Without this, tab navigation
          // lands on invisible buttons behind the content layer.
          style={offset >= 0 ? { pointerEvents: "none" } : undefined}
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
          className="absolute inset-y-0 left-0 flex"
          aria-hidden={offset <= 0}
          style={offset <= 0 ? { pointerEvents: "none" } : undefined}
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

      {/* Content layer — slides over the action layers */}
      <div
        className={cn(
          "relative bg-[var(--surface-base)] transition-transform",
          isDragging && "transition-none",
        )}
        style={{
          transform: `translateX(${offset}px)`,
          // Ensure the content layer paints above the action layers so they're
          // hidden until swiped. z-10 is enough since actions are auto-positioned.
          zIndex: 1,
        }}
      >
        {children}
      </div>
    </div>
  );
}
