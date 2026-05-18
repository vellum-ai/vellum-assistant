import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@vellum/design-library/utils/cn";

export interface ResizablePanelProps {
  left: ReactNode;
  right: ReactNode;
  defaultLeftWidth?: number;
  minLeftWidth?: number;
  minRightWidth?: number;
  onWidthChange?: (leftWidth: number) => void;
  storageKey?: string;
  className?: string;
}

/**
 * Horizontal split-view with a draggable divider.
 *
 * Uses pointer events with `setPointerCapture` for reliable cross-browser
 * drag tracking. No external resizable library is used.
 */
export function ResizablePanel({
  left,
  right,
  defaultLeftWidth = 400,
  minLeftWidth = 300,
  minRightWidth = 300,
  onWidthChange,
  storageKey,
  className,
}: ResizablePanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const [leftWidth, setLeftWidth] = useState<number>(() => {
    if (storageKey) {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored != null) {
          const parsed = Number(stored);
          if (Number.isFinite(parsed)) return parsed;
        }
      } catch {
        // localStorage access can throw under strict-privacy contexts.
      }
    }
    return defaultLeftWidth;
  });

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const clamp = useCallback(
    (width: number) => {
      const container = containerRef.current;
      if (!container) return width;
      const maxLeft = container.offsetWidth - minRightWidth;
      return Math.max(minLeftWidth, Math.min(width, maxLeft));
    },
    [minLeftWidth, minRightWidth],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startWidth: leftWidth };
      setIsDragging(true);
    },
    [leftWidth],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      const delta = e.clientX - dragRef.current.startX;
      const next = clamp(dragRef.current.startWidth + delta);
      setLeftWidth(next);
      onWidthChange?.(next);
    },
    [clamp, onWidthChange],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      const finalWidth = clamp(
        dragRef.current.startWidth + (e.clientX - dragRef.current.startX),
      );
      dragRef.current = null;
      setIsDragging(false);

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

  useEffect(() => {
    function onResize() {
      setLeftWidth((prev) => clamp(prev));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  return (
    <div
      ref={containerRef}
      className={cn("flex h-full w-full overflow-hidden", className)}
    >
      {/* Left pane */}
      <div
        className="flex h-full shrink-0 flex-col overflow-hidden"
        style={{ width: leftWidth }}
      >
        {left}
      </div>

      {/* Divider */}
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
      >
        <div className="h-full w-px bg-[var(--border-base)]" />
        <div
          className={cn(
            "absolute h-8 w-1 rounded-full bg-[var(--content-tertiary)] opacity-0 transition-opacity",
            "group-hover:opacity-100",
            isDragging && "opacity-100",
          )}
        />
      </div>

      {/* Right pane */}
      <div className="h-full min-w-0 flex-1 overflow-auto">
        {right}
      </div>
    </div>
  );
}
