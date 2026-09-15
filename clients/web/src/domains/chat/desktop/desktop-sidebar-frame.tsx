import { PaneResizeHandle, useResizablePane } from "@vellumai/design-library";
import { useCallback, useRef, type ReactNode } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";

interface DesktopSidebarFrameProps {
  children: ReactNode;
}

export function DesktopSidebarFrame({ children }: DesktopSidebarFrameProps) {
  const { t } = useTranslation("chat");
  const isMobile = useIsMobile();
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
      className="absolute inset-0 z-20 min-h-0 border-l border-[var(--border-base)] bg-[var(--surface-base)] md:relative md:inset-auto md:shrink-0"
      style={{ width: isMobile ? undefined : size }}
    >
      {!isMobile ? (
        <PaneResizeHandle
          {...handleProps}
          className="absolute inset-y-0 -left-1 z-10 w-2 hover:bg-[var(--border-base)]"
        />
      ) : null}
      <div className="h-full overflow-y-auto p-4">{children}</div>
    </aside>
  );
}
