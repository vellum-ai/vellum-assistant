/**
 * Animated right-hand drawer split — a drop-in for the tool-detail / thought-
 * process side panel that opens AND closes by ANIMATING THE DRAWER WIDTH
 * (0 ⇄ target) instead of reserving the full pane instantly.
 *
 * Why not `ResizablePanel`: that component sizes the left pane to a fixed width
 * and lets the right pane fill the rest (`flex-1`), so the moment it mounts the
 * chat column snaps to its narrow width and the full-size drawer pops in. The
 * result reads as "the layout shifted early and the drawer started too large".
 *
 * Here the chat is `flex-1` and the drawer is the sized element: as the drawer's
 * width eases 0 → target, the chat reflows in lockstep and the panel content —
 * pinned to the right edge at its final width — is revealed by a left-moving
 * wipe. Drag-to-resize + width persistence are preserved (ported from
 * `ResizablePanel`).
 *
 * Open/close is driven by the `open` prop, NOT by mounting/unmounting the
 * component. The drawer stays mounted around the chat so that (a) closing can
 * animate the width back to 0 — an unmount would skip the exit — and (b) the
 * chat (`left`) keeps the same tree position across open/close and never
 * remounts, preserving its scroll position. The drawer content is kept mounted
 * through the close animation and torn down only once the width reaches 0.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/utils/misc";

/** Width of the drag-handle column. Matches the `w-2` separator below (8px). */
const SEPARATOR_WIDTH_PX = 8;

/** Read a persisted pixel width from localStorage, validating shape/finiteness. */
function readStoredWidth(
  storageKey: string | undefined,
  minWidth: number,
): number | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored == null) return null;
    const parsed = Number(stored);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(minWidth, parsed);
  } catch {
    return null;
  }
}

export interface AnimatedRightDrawerProps {
  /** Whether the drawer is open. Drives the width animation in both directions. */
  open: boolean;
  /** Left (chat) content — fills the remaining space via `flex-1`. */
  left: ReactNode;
  /**
   * Right (drawer) content — rendered at the resolved width. May be `null`
   * once `open` flips to `false`; the last non-null value is retained so it
   * stays visible through the close animation.
   */
  right: ReactNode;
  /** Initial drawer width in px (default 400). */
  defaultWidth?: number;
  /** Minimum drawer width in px (default 400). */
  minWidth?: number;
  /** Minimum left-pane (chat) width in px (default 300). */
  minLeftWidth?: number;
  /** Optional localStorage key for persisting the drawer width across reloads. */
  storageKey?: string;
}

export function AnimatedRightDrawer({
  open,
  left,
  right,
  defaultWidth = 400,
  minWidth = 400,
  minLeftWidth = 300,
  storageKey,
}: AnimatedRightDrawerProps) {
  const reduce = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(
    () => readStoredWidth(storageKey, minWidth) ?? defaultWidth,
  );
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Keep the drawer pane (content + drag handle) mounted while open and through
  // the close animation. `mounted` flips on synchronously when opening, and off
  // only once the collapse-to-0 animation completes (see onAnimationComplete).
  const [mounted, setMounted] = useState(open);
  // Retain the last non-null content so it stays visible while the width eases
  // back to 0 — `right` typically becomes null the moment `open` flips false.
  const [retainedRight, setRetainedRight] = useState<ReactNode>(right);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  useEffect(() => {
    if (right != null) setRetainedRight(right);
  }, [right]);

  const clamp = useCallback(
    (next: number) => {
      const container = containerRef.current;
      if (!container) return Math.max(minWidth, next);
      const maxWidth = Math.max(
        minWidth,
        container.offsetWidth - minLeftWidth - SEPARATOR_WIDTH_PX,
      );
      return Math.max(minWidth, Math.min(next, maxWidth));
    },
    [minWidth, minLeftWidth],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startWidth: width };
      setIsDragging(true);
    },
    [width],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      // Dragging the handle LEFT (clientX decreases) widens the drawer.
      const delta = dragRef.current.startX - e.clientX;
      setWidth(clamp(dragRef.current.startWidth + delta));
    },
    [clamp],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      const finalWidth = clamp(
        dragRef.current.startWidth + (dragRef.current.startX - e.clientX),
      );
      dragRef.current = null;
      setIsDragging(false);
      setWidth(finalWidth);
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, String(finalWidth));
        } catch {
          // Storage quota or security error — ignore.
        }
      }
    },
    [clamp, storageKey],
  );

  // Re-clamp on container resize so the drawer never overruns the chat min.
  useEffect(() => {
    setWidth((prev) => clamp(prev));
    function onResize() {
      setWidth((prev) => clamp(prev));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  return (
    <div
      ref={containerRef}
      data-slot="animated-right-drawer"
      className="flex h-full w-full overflow-hidden"
    >
      {/* Chat — fills whatever the drawer doesn't, reflowing as the drawer
          animates open/closed so there's no early snap to the narrow width.
          `flex flex-col` gives the chat body (`flex-1`) a bounded height so its
          transcript can scroll — a plain block parent would let the body grow
          to content height and kill the scroll. */}
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">{left}</div>

      {/* Drag handle (matches ResizablePanel's hidden-divider look). Only
          present while the drawer is mounted so a closed drawer leaves no
          stray hit-area or grab handle over the full-width chat. */}
      {mounted && (
        <div
          role="separator"
          aria-orientation="vertical"
          className={cn(
            "group relative z-10 flex h-full w-2 shrink-0 cursor-col-resize items-center justify-center",
            isDragging && "select-none",
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div className="h-full w-px bg-transparent" />
          <div
            className={cn(
              "absolute h-8 w-1 rounded-full bg-[var(--content-tertiary)] opacity-0 transition-opacity",
              "group-hover:opacity-100",
              isDragging && "opacity-100",
            )}
          />
        </div>
      )}

      {/* Drawer — its width is the animated dimension, eased 0 ⇄ target by the
          `open` prop. The content sits in an absolutely-positioned layer pinned
          to the right edge at the final width, so changing the (overflow-hidden)
          wrapper width reveals/hides it with a left-moving wipe rather than
          reflowing the content mid-animation. Reduced motion: snap instead of
          ease. Content unmounts only once a close animation reaches width 0. */}
      <motion.div
        className="relative h-full shrink-0 overflow-hidden"
        initial={reduce ? false : { width: 0 }}
        animate={{ width: open ? width : 0 }}
        transition={
          isDragging || reduce
            ? { duration: 0 }
            : { duration: 0.34, ease: [0.16, 1, 0.3, 1] }
        }
        onAnimationComplete={() => {
          if (!open) setMounted(false);
        }}
      >
        {mounted && (
          <div className="absolute right-0 top-0 h-full" style={{ width }}>
            {retainedRight}
          </div>
        )}
      </motion.div>
    </div>
  );
}
