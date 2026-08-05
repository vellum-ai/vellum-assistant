import { SquarePen } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import { Button, cn } from "@vellumai/design-library";

export interface SideMenuOverlayBottomColumnProps {
  tipCard?: ReactNode;
  footerAction?: ReactNode;
  onStartNewConversation?: () => void;
  onClose?: () => void;
  /**
   * Reports the column's measured height so the scrollport behind it can
   * reserve matching bottom padding. Measured (not static) because the tip
   * card appears/disappears and its copy length varies.
   */
  onHeightChange: (height: number) => void;
}

/**
 * The overlay drawer's floating bottom column: the tip card above the
 * action pills (Preferences + New Chat) in the thumb zone, replacing the
 * rail's fixed footer rows (Figma 6764:6745). `pointer-events-none` on the
 * container keeps the list scrollable between/around the pills. The
 * container offsets itself by the bottom safe-area inset because the
 * overlay sheet runs full-bleed to the physical screen edge, keeping the
 * pills above the home indicator while letting their drop shadows fade out
 * naturally instead of being clipped at a safe-area boundary.
 */
export function SideMenuOverlayBottomColumn({
  tipCard,
  footerAction,
  onStartNewConversation,
  onClose,
  onHeightChange,
}: SideMenuOverlayBottomColumnProps) {
  const columnRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = columnRef.current;
    if (!el) {
      return;
    }

    const updateHeight = () => {
      onHeightChange(Math.ceil(el.getBoundingClientRect().height));
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onHeightChange]);

  return (
    <div
      ref={columnRef}
      className="pointer-events-none absolute inset-x-4 z-10 flex flex-col gap-4"
      style={{
        bottom:
          "calc(1rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
      }}
    >
      {/* `empty:hidden` collapses the row when the tip card renders
         null, so the column gap adds no phantom spacing. */}
      {tipCard ? (
        <div
          data-slot="tip-card-wrapper"
          className="pointer-events-auto empty:hidden"
        >
          {tipCard}
        </div>
      ) : null}
      {/* Grid, not flex: a plain `flex-1` on both children doesn't
         actually split them evenly here, since the Preferences pill
         (wrapped in its own div, see `footerAction` below) and the New
         Chat button (a flex item directly) don't carry the same
         content-based automatic minimum size, so equal flex-grow still
         resolves to unequal widths. `minmax(0,1fr)` tracks are immune
         to that: each column is forced to the same size regardless of
         its content or DOM depth. */}
      <div
        className={cn(
          "grid items-center gap-4",
          footerAction
            ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
            : "grid-cols-1",
        )}
      >
        {footerAction ? (
          <div className="pointer-events-auto min-w-0">{footerAction}</div>
        ) : null}
        {onStartNewConversation ? (
          <Button
            variant="primary"
            className="pointer-events-auto h-10 w-full rounded-full px-4 shadow-[var(--shadow-lg)]"
            leftIcon={<SquarePen />}
            onClick={() => {
              onStartNewConversation();
              onClose?.();
            }}
          >
            New Chat
          </Button>
        ) : null}
      </div>
    </div>
  );
}
