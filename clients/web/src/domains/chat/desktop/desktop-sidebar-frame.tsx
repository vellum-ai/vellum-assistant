import { PaneResizeHandle, useResizablePane } from "@vellumai/design-library";
import { Monitor } from "lucide-react";
import { useCallback, type ReactNode } from "react";

import { DetailShell } from "@/components/detail-shell";
import { DrawerWidthReveal } from "@/domains/chat/components/drawer-width-reveal";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";

import { useDesktopSidebarStore } from "./desktop-sidebar-store";

interface DesktopSidebarFrameProps {
  children: ReactNode;
}

export function DesktopSidebarFrame({ children }: DesktopSidebarFrameProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation();
  const isMobile = useIsMobile();
  const close = useDesktopSidebarStore.use.close();
  const { size, containerRef, paneId, handleProps, isResizing } = useResizablePane({
    side: "end",
    defaultSize: 400,
    minSize: 280,
    reserveForRest: 336,
    storageKey: "desktop-sidebar-width",
    label: t("assistantDesktop.resizeAria"),
    paneId: "assistant-desktop-sidebar",
  });
  const attachPane = useCallback(
    (node: HTMLElement | null) => {
      containerRef.current =
        node?.parentElement instanceof HTMLDivElement
          ? node.parentElement
          : null;
    },
    [containerRef],
  );

  const width = isMobile ? "100%" : size;

  return (
    <DrawerWidthReveal
      ref={attachPane}
      id={paneId}
      width={width}
      animateOnMount={!isMobile}
      instant={isMobile || isResizing}
      className="absolute inset-0 z-20 min-h-0 bg-[var(--surface-base)] md:relative md:inset-auto"
      resizeHandle={
        !isMobile ? (
          <PaneResizeHandle
            {...handleProps}
            className="absolute inset-y-0 left-0 z-10 w-2 hover:bg-[var(--border-base)]"
          />
        ) : null
      }
    >
      <aside
        aria-label={t("assistantDesktop.title")}
        className="h-full p-2"
        style={{ width }}
      >
        <DetailShell
          Glyph={Monitor}
          title={t("assistantDesktop.title")}
          closeLabel={tCommon("sideListDrawer.closeSidebarAria")}
          closeTooltip={tCommon("sideListDrawer.closeAria")}
          onClose={close}
        >
          {children}
        </DetailShell>
      </aside>
    </DrawerWidthReveal>
  );
}
