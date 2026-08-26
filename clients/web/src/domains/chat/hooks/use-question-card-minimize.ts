/**
 * Minimize / expand state for the pending `ask_question` card, and the vertical
 * drag that drives it.
 *
 * The card sits between the transcript and the composer, so at full height it
 * covers the assistant message the question is about (LUM-3390). Minimizing
 * leaves a one-line stand-in and hands the message back, and the state is
 * per-prompt: `QuestionPromptSlot` keys the card by `requestId`, so a new
 * question always arrives expanded.
 *
 * Motion is expressed as a single `progress` in `[0, 1]`, 1 expanded and 0
 * minimized, that every animated part of the card reads. At rest it is the
 * state itself and CSS eases between the two; during a drag it tracks the
 * finger directly and the card's transitions are dropped, so the card follows
 * the gesture rather than lagging behind it.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
} from "react";

import { useSwipeEngine } from "@/hooks/use-swipe-engine";
import { haptic } from "@/utils/haptics";

/**
 * Vertical travel (px) that carries the card the whole way between states.
 * Shorter than the card is tall: the collapse should read as finished well
 * before the finger reaches the composer.
 */
export const MINIMIZE_TRAVEL_PX = 120;

/**
 * Vertical travel (px) at which a release commits to the other state. Set
 * around half of {@link MINIMIZE_TRAVEL_PX} so the card is visibly past the
 * midpoint before releasing counts, and springs back from anything less.
 */
export const MINIMIZE_COMMIT_PX = 64;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Where the card sits between minimized (0) and expanded (1) for a given
 * resting state and live drag offset. `dragOffset` is positive downward, which
 * is the direction that collapses.
 */
export function collapseProgress(
  isMinimized: boolean,
  dragOffset: number,
): number {
  const resting = isMinimized ? 0 : 1;
  return clamp01(resting - dragOffset / MINIMIZE_TRAVEL_PX);
}

/**
 * Opacity for chrome that belongs to the expanded card (the description, the
 * pager). Gone by the halfway point so it has cleared out before the summary
 * line it shares the header with fades in.
 */
export function expandedChromeOpacity(progress: number): number {
  return clamp01(progress * 2 - 1);
}

/**
 * Opacity for the one-line summary that stands in for the collapsed body. The
 * mirror of {@link expandedChromeOpacity}: the two never overlap, so the header
 * reads as one line swapping for another rather than as two lines dissolving
 * through each other.
 */
export function minimizedChromeOpacity(progress: number): number {
  return clamp01(1 - progress * 2);
}

export interface QuestionCardDragHandlers {
  onTouchStart: (event: ReactTouchEvent) => void;
  onTouchMove: (event: ReactTouchEvent) => void;
  onTouchEnd: (event: ReactTouchEvent) => void;
  onTouchCancel: () => void;
  onClickCapture: (event: ReactMouseEvent) => void;
}

export interface UseQuestionCardMinimizeResult {
  /** Whether the card is resting in its minimized state. */
  isMinimized: boolean;
  /** 0 minimized, 1 expanded, fractional mid-drag. */
  progress: number;
  /** True while a vertical drag is tracking the finger. */
  isDragging: boolean;
  /** `data-dragging` value for every element the drag animates. */
  dragAttr: "true" | undefined;
  /** Flips the state. Backs the header's minimize / reopen button. */
  toggle: () => void;
  /** Reopens a minimized card. Backs the header's tap target. */
  expand: () => void;
  /** Touch handlers for the card's drag surface. */
  dragHandlers: QuestionCardDragHandlers;
}

export function useQuestionCardMinimize(): UseQuestionCardMinimizeResult {
  const [isMinimized, setIsMinimized] = useState(false);

  // A tap that ends a drag must not also toggle. `touchend` runs before the
  // synthetic `click`, so the flag is raised while the drag resolves and
  // cleared by the next touch rather than on release.
  const draggedRef = useRef(false);

  const swipe = useSwipeEngine({
    enabled: true,
    axis: "vertical",
    commitThresholdPx: MINIMIZE_COMMIT_PX,
    // The card follows the finger one-to-one for its whole travel. The engine's
    // default damping is there to signal "release to commit" on gestures that
    // have nowhere to travel to; this one does, and `collapseProgress` clamps
    // at both ends, which is the resistance the gesture needs.
    overdragDamping: 1,
    onMove: () => {
      draggedRef.current = true;
    },
    onCommit: (delta) => {
      haptic.light();
      setIsMinimized(delta > 0);
    },
  });

  const { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } = swipe;

  const handleTouchStart = useCallback(
    (event: ReactTouchEvent) => {
      draggedRef.current = false;
      onTouchStart(event);
    },
    [onTouchStart],
  );

  const toggle = useCallback(() => {
    setIsMinimized((minimized) => !minimized);
  }, []);

  // Drag suppression lives in `onClickCapture` below, which stops the click
  // before it reaches any handler, so this one is free to be unconditional.
  const expand = useCallback(() => {
    setIsMinimized(false);
  }, []);

  /**
   * Swallows the click a drag leaves behind. The whole card is a drag surface,
   * so a gesture that starts on an option row and ends without committing would
   * otherwise release into that row's `onClick` and answer the question. Runs
   * in the capture phase so it lands before the row does, and clears the flag
   * as it fires so it only ever eats the one click the drag produced.
   */
  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (!draggedRef.current) {
      return;
    }
    draggedRef.current = false;
    event.stopPropagation();
    event.preventDefault();
  }, []);

  const dragHandlers = useMemo(
    () => ({
      onTouchStart: handleTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel,
      onClickCapture,
    }),
    [handleTouchStart, onTouchMove, onTouchEnd, onTouchCancel, onClickCapture],
  );

  return {
    isMinimized,
    progress: collapseProgress(isMinimized, swipe.dragOffset),
    isDragging: swipe.isDragging,
    dragAttr: swipe.isDragging ? "true" : undefined,
    toggle,
    expand,
    dragHandlers,
  };
}
