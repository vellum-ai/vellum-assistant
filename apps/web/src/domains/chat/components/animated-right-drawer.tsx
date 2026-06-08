/**
 * Animated right-hand drawer split — a drop-in for the tool-detail / thought-
 * process side panel that opens by ANIMATING THE DRAWER WIDTH (0 → target)
 * instead of reserving the full pane instantly.
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
 * `ResizablePanel`), so only the open transition changes.
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
  /** Left (chat) content — fills the remaining space via `flex-1`. */
  left: ReactNode;
  /** Right (drawer) content — rendered at the resolved width. */
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
          animates open so there's no early snap to the narrow width. */}
      <div className="h-full min-w-0 flex-1 overflow-hidden">{left}</div>

      {/* Drag handle (matches ResizablePanel's hidden-divider look). */}
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

      {/* Drawer — its width is the animated dimension. The content sits in an
          absolutely-positioned layer pinned to the right edge at the final
          width, so growing the (overflow-hidden) wrapper reveals it with a
          left-moving wipe rather than reflowing the content mid-animation.
          Reduced motion: skip the enter (`initial={false}`) so it just appears. */}
      <motion.div
        className="relative h-full shrink-0 overflow-hidden"
        initial={reduce ? false : { width: 0 }}
        animate={{ width }}
        transition={
          isDragging || reduce
            ? { duration: 0 }
            : { duration: 0.34, ease: [0.16, 1, 0.3, 1] }
        }
      >
        <div className="absolute right-0 top-0 h-full" style={{ width }}>
          {right}
        </div>
      </motion.div>
    </div>
  );
}
