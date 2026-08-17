import { useRef, type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn";
import { useResizablePane } from "../hooks/use-resizable-pane";
import { PaneResizeHandle } from "./pane-resize-handle";

/**
 * Width of the drag-handle column between the two panes. Must match the
 * Tailwind `w-2` class on the handle below (0.5rem = 8px under the default
 * rem), because it is reserved out of the container when resolving how wide
 * the right pane may be.
 */
const HANDLE_WIDTH_PX = 8;

/**
 * Suffix for the persisted width. The stored number is the right pane's width;
 * a bare `storageKey` holds the left pane's, so the two are kept in separate
 * entries and the bare one is converted on first read. Callers pass the bare
 * key and never see this.
 */
const STORAGE_FORMAT_SUFFIX = ".v2";

export interface ResizablePanelProps
  extends Omit<ComponentProps<"div">, "children"> {
  /** Content for the left pane, which fills whatever the right pane does not. */
  left: ReactNode;
  /** Content for the right pane, the one that owns a width. */
  right: ReactNode;
  /** Initial width of the right pane in px (default 400). */
  defaultRightWidth?: number;
  /** Minimum right pane width in px (default 300). */
  minRightWidth?: number;
  /** Minimum left pane width in px (default 300), reserved out of the container. */
  minLeftWidth?: number;
  /** Called with the right pane's width after a drag or a key press. */
  onWidthChange?: (rightWidth: number) => void;
  /**
   * Accessible name for the drag separator (default "Resize panels"). Set it
   * when a page has more than one split so the two are told apart.
   */
  separatorLabel?: string;
  /** Optional `localStorage` key for persisting the width across reloads. */
  storageKey?: string;
  /**
   * Hide the always-visible 1px divider line while keeping the full drag
   * hit-area and the grab handle. For when the right pane already has its own
   * container chrome and the divider reads as a redundant extra border.
   */
  hideDivider?: boolean;
}

/**
 * A sized right pane beside a flexible left one, with a draggable and
 * keyboard-operable edge between them.
 *
 * Panes are sized in pixels: the right pane owns a width and the left pane
 * takes the remainder. Sizing, clamping, persistence, and the separator's ARIA
 * come from `useResizablePane`, shared with the sidebar rail and the
 * tool-detail drawer.
 */
export function ResizablePanel({
  left,
  right,
  defaultRightWidth = 400,
  minRightWidth = 300,
  minLeftWidth = 300,
  onWidthChange,
  separatorLabel = "Resize panels",
  storageKey,
  hideDivider = false,
  className,
  ...rest
}: ResizablePanelProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const { size, containerRef, paneId, handleProps, isResizing } =
    useResizablePane({
      side: "end",
      defaultSize: defaultRightWidth,
      minSize: minRightWidth,
      reserveForRest: minLeftWidth + HANDLE_WIDTH_PX,
      storageKey: storageKey
        ? `${storageKey}${STORAGE_FORMAT_SUFFIX}`
        : undefined,
      legacySize: storageKey
        ? {
            key: storageKey,
            convert: (leftWidth: number, containerWidth: number) =>
              containerWidth - leftWidth - HANDLE_WIDTH_PX,
          }
        : undefined,
      label: separatorLabel,
      paneRef,
      onSizeCommit: onWidthChange,
    });

  return (
    <div
      {...rest}
      ref={containerRef}
      data-slot="resizable-panel"
      className={cn("flex h-full w-full overflow-hidden", className)}
    >
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {left}
      </div>

      <PaneResizeHandle
        {...handleProps}
        className={cn(
          "group relative z-10 flex h-full w-2 shrink-0 items-center justify-center",
          isResizing && "select-none",
        )}
      >
        <div
          className={cn(
            "h-full w-px",
            hideDivider ? "bg-transparent" : "bg-[var(--border-base)]",
          )}
        />
        <div
          className={cn(
            "absolute h-8 w-1 rounded-full bg-[var(--content-tertiary)] opacity-0 transition-opacity",
            "group-hover:opacity-100 group-focus-visible:opacity-100",
            isResizing && "opacity-100",
          )}
        />
      </PaneResizeHandle>

      {/* `size` is the committed width. During a drag the hook writes this
          element's width directly and skips the commit, so tracking the cursor
          costs no React render; the two agree again on release. */}
      <div
        id={paneId}
        ref={paneRef}
        className="h-full shrink-0 overflow-auto"
        style={{ width: size }}
      >
        {right}
      </div>
    </div>
  );
}
