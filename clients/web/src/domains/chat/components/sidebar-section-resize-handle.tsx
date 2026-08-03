/**
 * The section list's one rule, doubling as the Pinned section's resize
 * handle.
 *
 * Visually it stays the 1px divider between the curated block and the
 * conversations below it. While the Pinned section is present and expanded,
 * a taller invisible hit strip over the line drags with a `row-resize`
 * cursor: each pointer move writes the tracked height straight to the
 * section's bounded scroll div (no per-frame React state, matching the
 * side-menu width handle), and release commits the final clamped height for
 * persistence. Double-click returns the section to its default height.
 *
 * The element tree is identical in the inert and resizable states; only the
 * handlers and cursor/touch affordances are gated. Swapping elements on that
 * flag would drop pointer capture mid-drag if the last pin vanished (say,
 * from another window) and strand the body-level cursor override.
 */

import {
  useEffect,
  useRef,
  type PointerEvent,
  type RefObject,
} from "react";

import { clampPinnedSectionHeight } from "@/domains/chat/utils/sidebar-pinned-height";
import { cn } from "@/utils/misc";

export interface SidebarSectionResizeHandleProps {
  /** Bounded scroll div of the Pinned section; its maxHeight is driven during the drag. */
  targetRef: RefObject<HTMLDivElement | null>;
  /** False while Pinned is absent or collapsed: the rule stays, the drag affordance goes. */
  resizable: boolean;
  /** Final clamped height, fired on release only when it changed. */
  onCommit: (height: number) => void;
  /** Double-click: return the section to its default height. */
  onReset?: () => void;
}

export function SidebarSectionResizeHandle({
  targetRef,
  resizable,
  onCommit,
  onReset,
}: SidebarSectionResizeHandleProps) {
  const dragRef = useRef<{
    startY: number;
    startHeight: number;
    initialHeight: number;
    lastHeight: number;
  } | null>(null);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = targetRef.current;
    if (!resizable || event.button !== 0 || !target) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // Start from the rendered height, not the configured cap, so shrinking a
    // section shorter than its cap bites on the first pixel.
    const startHeight = target.getBoundingClientRect().height;
    const initialHeight = clampPinnedSectionHeight(startHeight);
    dragRef.current = {
      startY: event.clientY,
      startHeight,
      initialHeight,
      lastHeight: initialHeight,
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const next = clampPinnedSectionHeight(
      drag.startHeight + (event.clientY - drag.startY),
    );
    drag.lastHeight = next;
    // The section can unmount mid-drag (unpinned elsewhere, accordion
    // collapsed). Capture lives on this element, so keep tracking and let
    // release settle the bookkeeping.
    const target = targetRef.current;
    if (target) {
      target.style.maxHeight = `${next}px`;
    }
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // Commit the move-tracked height rather than one recomputed from this
    // event: pointercancel can carry a garbage coordinate. A press that
    // never moved commits nothing, so a stray tap on the divider cannot
    // quietly re-cap the section to its rendered height.
    if (drag.lastHeight !== drag.initialHeight) {
      onCommit(drag.lastHeight);
    }
  };

  useEffect(() => {
    return () => {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, []);

  return (
    <div
      data-slot="sidebar-section-resize-handle"
      data-resizable={resizable ? "" : undefined}
      role="separator"
      aria-orientation="horizontal"
      aria-label={resizable ? "Pinned section height" : undefined}
      className="group/resize relative h-px w-full bg-[var(--border-base)]"
    >
      {/* The hit strip overshoots the line into the section gaps (wider on
          mobile, where there is no hover and fingers are blunt). */}
      <div
        className={cn(
          "absolute inset-x-0 -top-1 -bottom-1 z-10",
          resizable && "cursor-row-resize touch-none",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={resizable ? onReset : undefined}
      />
      {resizable ? (
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-1 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--content-tertiary)] opacity-0 transition-opacity group-hover/resize:opacity-100 max-md:opacity-60" />
      ) : null}
    </div>
  );
}
