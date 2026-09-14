import { MessageSquarePlus } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "@/i18n";

import { Button } from "@vellumai/design-library";

export interface SideMenuOverlayBottomColumnProps {
  footerAction?: ReactNode;
  onStartNewConversation?: () => void;
  onClose?: () => void;
  /**
   * Reports the column's measured height so the scrollport behind it can end
   * above the rendered action pills.
   */
  onHeightChange: (height: number) => void;
}

/**
 * The overlay drawer's floating bottom action pills (Preferences + New Chat)
 * sit in the thumb zone, replacing the rail's fixed footer row (Figma
 * 6764:6745). `pointer-events-none` on the
 * container keeps the list scrollable between/around the pills. The
 * container offsets itself by the bottom safe-area inset because the
 * overlay sheet runs full-bleed to the physical screen edge, keeping the
 * pills above the home indicator while letting their drop shadows fade out
 * naturally instead of being clipped at a safe-area boundary.
 */
export function SideMenuOverlayBottomColumn({
  footerAction,
  onStartNewConversation,
  onClose,
  onHeightChange,
}: SideMenuOverlayBottomColumnProps) {
  const { t } = useTranslation("chat");
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
      data-slot="side-menu-overlay-bottom-column"
      className="pointer-events-none absolute inset-x-3 z-10 flex flex-col gap-4"
      style={{
        bottom:
          "calc(1rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
      }}
    >
      {/* The two pills are sized by what they carry rather than split
         evenly: Preferences shrink-wraps its avatar and name, and New Chat
         takes the rest of the row. `min-w-0` on the shrinking one keeps a
         long display name from pushing New Chat off the row. */}
      <div className="flex items-center gap-2">
        {footerAction ? (
          <div className="pointer-events-auto min-w-0 shrink">
            {footerAction}
          </div>
        ) : null}
        {onStartNewConversation ? (
          <Button
            variant="primary"
            /* Sized as the drawer's rows are: the pills above it set their
               labels in the large body size and draw their glyphs at 16px on
               a phone, so this reads as one of them rather than a smaller
               control beneath them. The glyph is content rather than
               `leftIcon`, whose box the button sizes inline at 14px. */
            className="pointer-events-auto min-h-[var(--side-menu-tile-size,36px)] w-full min-w-0 flex-1 gap-2 rounded-full px-3 shadow-[var(--shadow-lg)] max-md:text-body-large-default"
            onClick={() => {
              onStartNewConversation();
              onClose?.();
            }}
          >
            <MessageSquarePlus
              aria-hidden
              className="size-3.5 shrink-0 max-md:size-4"
            />
            {t("sideMenuOverlayBottomColumn.newChat")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
