import { useCallback, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";

import { haptic } from "@/utils/haptics";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Width (px) of each revealed action button. Matches the standard iOS
 * swipe-action height/width (~72px) so a single action fills its tap target
 * and multiple actions stack without crowding.
 */
export const ACTION_WIDTH_PX = 72;

/**
 * Minimum horizontal travel (px) to commit to the revealed state. Below this
 * the row springs back to rest. Tuned to ~half the action width so a casual
 * drag doesn't accidentally reveal actions, but an intentional swipe does.
 */
const COMMIT_THRESHOLD_PX = 36;

/**
 * If vertical travel exceeds this ratio of horizontal travel, the gesture is a
 * scroll, not a swipe — we bail so the browser's scrolling is never hijacked.
 * Matches {@link use-gallery-swipe}'s vertical escape ratio.
 */
const VERTICAL_ESCAPE_RATIO = 0.8;

/** Travel (px) on either axis before we decide the gesture's direction. */
const DIRECTION_DEADZONE_PX = 8;

/**
 * Damping applied to drag distance once it passes the reveal width, so the
 * content resists further travel and signals "release to snap" rather than
 * sliding away indefinitely. Matches {@link use-gallery-swipe}'s overdrag.
 */
const OVERDRAG_DAMPING = 0.35;

type GestureAxis = "undecided" | "horizontal" | "vertical";
type RevealSide = "none" | "leading" | "trailing";

export interface SwipeAction {
  /** Unique identifier for the action. */
  id: string;
  /** Accessible label for the button. */
  label: string;
  /** Icon component to render inside the action button. */
  icon: React.ComponentType<{ size?: number }>;
  /** Called when the action button is tapped. */
  onSelect: () => void;
  /** Visual style. "destructive" renders in red (e.g. Delete, Archive). */
  variant?: "default" | "destructive";
}

interface UseSwipeToRevealArgs {
  /** Whether swipe is enabled (typically `isPointerCoarse()`). */
  enabled: boolean;
  /** Actions revealed on swipe-right (leading / left side). */
  leadingActions?: SwipeAction[];
  /** Actions revealed on swipe-left (trailing / right side). */
  trailingActions?: SwipeAction[];
}

interface UseSwipeToRevealResult {
  /** Live horizontal drag offset (px) to translate the content by. 0 at rest. */
  offset: number;
  /** True while a horizontal drag is in progress (disable transitions). */
  isDragging: boolean;
  /** Which side's actions are currently revealed ("none" when closed). */
  revealedSide: RevealSide;
  /** Total width of revealed actions on the leading side (px). */
  leadingWidth: number;
  /** Total width of revealed actions on the trailing side (px). */
  trailingWidth: number;
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchEnd: (e: ReactTouchEvent) => void;
  onTouchCancel: () => void;
  /** Programmatically close any revealed actions (e.g. on tap-outside). */
  close: () => void;
}

/**
 * Swipe-to-reveal-actions hook for list rows. Tracks a single touch, follows
 * the finger with a live `offset`, and on release snaps to the revealed state
 * if travel passed {@link COMMIT_THRESHOLD_PX}, else springs back to rest.
 *
 * - Swipe left → reveals `trailingActions` (right side, like iOS Mail archive)
 * - Swipe right → reveals `leadingActions` (left side, like iOS Mail flag)
 *
 * If the row is already revealed, swiping back toward center closes it.
 * Vertical-dominant gestures are ignored so list scrolling is never hijacked.
 *
 * Modeled on the gesture bookkeeping in {@link use-gallery-swipe}.
 */
export function useSwipeToReveal({
  enabled,
  leadingActions,
  trailingActions,
}: UseSwipeToRevealArgs): UseSwipeToRevealResult {
  const leadingWidth = (leadingActions?.length ?? 0) * ACTION_WIDTH_PX;
  const trailingWidth = (trailingActions?.length ?? 0) * ACTION_WIDTH_PX;

  // `-trailingWidth` = trailing actions revealed, `+leadingWidth` = leading.
  const [offset, setOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [revealedSide, setRevealedSide] = useState<RevealSide>("none");

  const gesture = useRef<{
    touchId: number;
    startX: number;
    startY: number;
    axis: GestureAxis;
    lastDx: number;
    /** Offset the row was at when the gesture started (non-zero if revealed). */
    startOffset: number;
  } | null>(null);

  const reset = useCallback(() => {
    gesture.current = null;
    setIsDragging(false);
  }, []);

  const close = useCallback(() => {
    setOffset(0);
    setRevealedSide("none");
  }, []);

  const onTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      if (!enabled || (!leadingActions && !trailingActions)) {return;}
      if (e.touches.length !== 1) {
        reset();
        return;
      }
      const t = e.touches[0]!;
      gesture.current = {
        touchId: t.identifier,
        startX: t.clientX,
        startY: t.clientY,
        axis: "undecided",
        lastDx: 0,
        startOffset: offset,
      };
    },
    [enabled, leadingActions, trailingActions, offset, reset],
  );

  const onTouchMove = useCallback(
    (e: ReactTouchEvent) => {
      const g = gesture.current;
      if (!g) {return;}
      if (e.touches.length !== 1) {
        reset();
        return;
      }
      const t = e.touches[0]!;
      if (t.identifier !== g.touchId) {return;}

      const dx = t.clientX - g.startX;
      const dy = t.clientY - g.startY;
      g.lastDx = dx;

      if (g.axis === "undecided") {
        if (
          Math.abs(dx) < DIRECTION_DEADZONE_PX &&
          Math.abs(dy) < DIRECTION_DEADZONE_PX
        ) {
          return;
        }
        if (Math.abs(dy) > Math.abs(dx) * VERTICAL_ESCAPE_RATIO) {
          gesture.current = null;
          return;
        }
        g.axis = "horizontal";
        setIsDragging(true);
      }

      if (g.axis !== "horizontal") {return;}

      // Mid-gesture vertical escape (mirrors gallery-swipe).
      if (
        Math.abs(dx) < COMMIT_THRESHOLD_PX &&
        Math.abs(dy) > Math.abs(dx) * VERTICAL_ESCAPE_RATIO
      ) {
        reset();
        setOffset(g.startOffset);
        return;
      }

      // Raw offset = starting position + drag delta.
      let raw = g.startOffset + dx;

      // Clamp to the available reveal range on each side.
      const maxRight = leadingWidth;
      const maxLeft = -trailingWidth;

      if (raw > maxRight) {
        // Overdrag past leading actions.
        raw =
          maxRight + (raw - maxRight) * OVERDRAG_DAMPING;
      } else if (raw < maxLeft) {
        // Overdrag past trailing actions.
        raw =
          maxLeft + (raw - maxLeft) * OVERDRAG_DAMPING;
      }

      // If the row started revealed and the user drags past center, allow
      // crossing to the other side's actions.
      if (g.startOffset > 0 && raw < 0 && trailingWidth === 0) {
        raw = raw * OVERDRAG_DAMPING;
      } else if (g.startOffset < 0 && raw > 0 && leadingWidth === 0) {
        raw = raw * OVERDRAG_DAMPING;
      }

      setOffset(raw);
    },
    [leadingWidth, trailingWidth, reset],
  );

  const onTouchEnd = useCallback(
    (e: ReactTouchEvent) => {
      const g = gesture.current;
      if (!g || g.axis !== "horizontal") {
        reset();
        return;
      }
      if (e.touches.length > 0) {
        reset();
        return;
      }

      const released = Array.from(e.changedTouches).find(
        (t) => t.identifier === g.touchId,
      );
      const finalDx = released ? released.clientX - g.startX : g.lastDx;
      const finalOffset = g.startOffset + finalDx;

      if (finalOffset <= -COMMIT_THRESHOLD_PX && trailingWidth > 0) {
        // Commit: reveal trailing actions.
        haptic.light();
        setOffset(-trailingWidth);
        setRevealedSide("trailing");
      } else if (finalOffset >= COMMIT_THRESHOLD_PX && leadingWidth > 0) {
        // Commit: reveal leading actions.
        haptic.light();
        setOffset(leadingWidth);
        setRevealedSide("leading");
      } else {
        // Snap back to rest.
        setOffset(0);
        setRevealedSide("none");
      }

      reset();
    },
    [leadingWidth, trailingWidth, reset],
  );

  return {
    offset,
    isDragging,
    revealedSide,
    leadingWidth,
    trailingWidth,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel: close,
    close,
  };
}
