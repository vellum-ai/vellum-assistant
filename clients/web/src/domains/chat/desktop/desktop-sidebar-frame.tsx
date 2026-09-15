import { PaneResizeHandle, useResizablePane } from "@vellumai/design-library";
import { Monitor } from "lucide-react";
import { useCallback, useRef, type ReactNode } from "react";

import { DetailShell } from "@/components/detail-shell";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";

import { useDesktopSidebarStore } from "./desktop-sidebar-store";

interface DesktopSidebarFrameProps {
  children: ReactNode;
}

export function DesktopSidebarFrame({ children }: DesktopSidebarFrameProps) {
  const { t } = useTranslation("chat");
  const isMobile = useIsMobile();
  const close = useDesktopSidebarStore.use.close();
  const paneRef = useRef<HTMLElement>(null);
  const { size, containerRef, paneId, handleProps } = useResizablePane({
    side: "end",
    defaultSize: 400,
    minSize: 280,
    reserveForRest: 336,
    storageKey: "desktop-sidebar-width",
    label: t("assistantDesktop.resizeAria"),
    paneId: "assistant-desktop-sidebar",
    paneRef: isMobile ? undefined : paneRef,
  });
  const attachPane = useCallback(
    (node: HTMLElement | null) => {
      paneRef.current = node;
      containerRef.current =
        node?.parentElement instanceof HTMLDivElement
          ? node.parentElement
          : null;
    },
    [containerRef],
  );

  return (
    <aside
      ref={attachPane}
      id={paneId}
      aria-label={t("assistantDesktop.title")}
      className="absolute inset-0 z-20 min-h-0 bg-[var(--surface-base)] p-2 md:relative md:inset-auto md:shrink-0"
      style={{ width: isMobile ? undefined : size }}
    >
      {!isMobile ? (
        <PaneResizeHandle
          {...handleProps}
          className="absolute inset-y-0 -left-1 z-10 w-2 hover:bg-[var(--border-base)]"
        />
      ) : null}
      <DetailShell
        Glyph={Monitor}
        title={t("assistantDesktop.title")}
        closeLabel={t("common:sideListDrawer.closeSidebarAria")}
        closeTooltip={t("common:sideListDrawer.closeAria")}
        onClose={close}
      >
        {children}
      </DetailShell>
    </aside>
  );
}
