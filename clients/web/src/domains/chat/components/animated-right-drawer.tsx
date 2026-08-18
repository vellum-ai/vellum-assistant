/**
 * Animated right-hand drawer split — a drop-in for the tool-detail / thought-
 * process side panel that opens AND closes by ANIMATING THE DRAWER WIDTH
 * (0 ⇄ target) instead of reserving the full pane instantly.
 *
 * Why not `ResizablePanel`: that component reserves the drawer's full width the
 * moment it mounts, so the chat column snaps to its narrow width and the
 * full-size drawer pops in. The result reads as "the layout shifted early and
 * the drawer started too large".
 *
 * Here the chat is `flex-1` and the drawer is the sized element: as the drawer's
 * width eases 0 → target, the chat reflows in lockstep and the panel content —
 * pinned to the right edge at its final width — is revealed by a left-moving
 * wipe. Drag-to-resize, clamping, and width persistence come from
 * `useResizablePane`, shared with `ResizablePanel` and the sidebar rail, so
 * this file contributes only the animation.
 *
 * Open/close is driven by the `open` prop, NOT by mounting/unmounting the
 * component. The drawer stays mounted around the chat so that (a) closing can
 * animate the width back to 0 — an unmount would skip the exit — and (b) the
 * chat (`left`) keeps the same tree position across open/close and never
 * remounts, preserving its scroll position. The drawer content is kept mounted
 * through the close animation and torn down only once the width reaches 0.
 */

import { useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { PaneResizeHandle, useResizablePane } from "@vellumai/design-library";

import { cn } from "@/utils/misc";

/** Width of the drag-handle column. Matches the `w-2` handle below (8px). */
const HANDLE_WIDTH_PX = 8;

/**
 * The drawer's geometry, owned here so every mount resolves the same numbers.
 * Default and minimum are equal, so the drawer opens at the same width it
 * floors at under a drag. That floor is not absolute: a container too narrow
 * to hold it caps the drawn width below it, see `renderWidth` below.
 */
const RIGHT_DRAWER_MIN_WIDTH_PX = 400;
const RIGHT_DRAWER_DEFAULT_WIDTH_PX = RIGHT_DRAWER_MIN_WIDTH_PX;
const RIGHT_DRAWER_MIN_LEFT_WIDTH_PX = 300;

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
  defaultWidth = RIGHT_DRAWER_DEFAULT_WIDTH_PX,
  minWidth = RIGHT_DRAWER_MIN_WIDTH_PX,
  minLeftWidth = RIGHT_DRAWER_MIN_LEFT_WIDTH_PX,
  storageKey,
}: AnimatedRightDrawerProps) {
  const reduce = useReducedMotion();
  // No `paneRef`: motion owns the drawer element's width, so the live size has
  // to come through React state for `animate` to see it.
  const {
    size: width,
    containerSize,
    containerRef,
    paneId,
    handleProps,
    isResizing,
  } = useResizablePane({
    side: "end",
    defaultSize: defaultWidth,
    minSize: minWidth,
    reserveForRest: minLeftWidth + HANDLE_WIDTH_PX,
    storageKey,
    label: "Resize side panel",
  });

  // `useResizablePane` never clamps below `minWidth`, so a container narrower
  // than `minWidth + handle` (small window, wide sidebar) would let the drawer
  // overflow its overflow-hidden host and clip the panel's right edge, where
  // the close button lives. Cap the drawn width to what the container can
  // actually show and let the chat column collapse; the content layer below
  // renders at this capped width so the panel reflows instead of clipping.
  // `containerSize` is 0 until the first measure, so fall back to `width`.
  const renderWidth =
    containerSize > 0
      ? Math.min(width, Math.max(0, containerSize - HANDLE_WIDTH_PX))
      : width;
  const isCapped = renderWidth < width;

  // Keep the drawer pane (content + drag handle) mounted while open and through
  // the close animation. `mounted` flips on synchronously when opening, and off
  // only once the collapse-to-0 animation completes (see onAnimationComplete).
  const [mounted, setMounted] = useState(open);
  // Retain the last non-null content so it stays visible while the width eases
  // back to 0 after `open` flips false and `right` becomes null. While open the
  // live `right` renders directly (below) so a streaming panel paints
  // immediately; this retained copy only backs the close wipe.
  const [retainedRight, setRetainedRight] = useState<ReactNode>(right);
  // Both adjustments are guarded render-phase setState (the "adjusting state
  // when a prop changes" pattern from react.dev). `right` is a fresh element
  // on every parent render, so an effect keyed on it would queue a setState
  // into every commit's passive phase while the drawer is open, and enough
  // such commits back to back trip React's nested-update limit under
  // streaming load (error 185, LUM-3062). A render-phase adjustment
  // re-renders before commit and adds nothing to the commit stream. See
  // `lib/commit-pressure.ts` for the accounting.
  if (open && !mounted) {
    setMounted(true);
  }
  if (right != null && right !== retainedRight) {
    setRetainedRight(right);
  }

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
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {left}
      </div>

      {/* Drag handle. Only present while the drawer is mounted so a closed
          drawer leaves no stray hit-area or grab handle over the full-width
          chat. */}
      {mounted && (
        <PaneResizeHandle
          {...handleProps}
          className={cn(
            "group relative z-10 flex h-full w-2 shrink-0 items-center justify-center",
            isResizing && "select-none",
          )}
        >
          <div className="h-full w-px bg-transparent" />
          <div
            className={cn(
              "absolute h-8 w-1 rounded-full bg-[var(--content-tertiary)] opacity-0 transition-opacity",
              "group-hover:opacity-100 group-focus-visible:opacity-100",
              isResizing && "opacity-100",
            )}
          />
        </PaneResizeHandle>
      )}

      {/* Drawer — its width is the animated dimension, eased 0 ⇄ target by the
          `open` prop. The content sits in an absolutely-positioned layer pinned
          to the right edge at the final width, so changing the (overflow-hidden)
          wrapper width reveals/hides it with a left-moving wipe rather than
          reflowing the content mid-animation. Reduced motion: snap instead of
          ease. Content unmounts only once a close animation reaches width 0. */}
      <motion.div
        id={paneId}
        className="relative h-full shrink-0 overflow-hidden"
        // Hard ceiling for the frames between a container resize and the
        // re-measure landing in state: flex honors max-width over the
        // motion-driven inline width, so the drawer can never paint past its
        // host even before `renderWidth` catches up.
        style={{ maxWidth: `calc(100% - ${HANDLE_WIDTH_PX}px)` }}
        // Mount at the resting width for whatever `open` says, so the wipe is
        // driven by `open` changing and not by the component appearing. A
        // drawer mounted already-open belongs to a panel that is already
        // there: remounts (the mobile/desktop crossing in `chat-route-content`
        // swaps this whole subtree) would otherwise replay the entrance over
        // a panel the user has been looking at.
        initial={false}
        animate={{ width: open ? renderWidth : 0 }}
        // While capped, width changes track a live container resize, so ease
        // would lag the window edge; snap instead, like a handle drag.
        transition={
          isResizing || isCapped || reduce
            ? { duration: 0 }
            : { duration: 0.34, ease: [0.16, 1, 0.3, 1] }
        }
        onAnimationComplete={() => {
          if (!open) {
            setMounted(false);
          }
        }}
      >
        {mounted && (
          <div
            className="absolute right-0 top-0 h-full"
            style={{ width: renderWidth }}
          >
            {/* Render live `right` while present so a streaming panel isn't a
                frame behind; fall back to the retained copy during the close
                wipe once `right` has gone null. */}
            {right ?? retainedRight}
          </div>
        )}
      </motion.div>
    </div>
  );
}
