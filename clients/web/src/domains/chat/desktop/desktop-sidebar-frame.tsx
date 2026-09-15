import { Monitor } from "lucide-react";
import type { ReactNode } from "react";

import { DetailShell } from "@/components/detail-shell";
import { AnimatedRightDrawer } from "@/domains/chat/components/animated-right-drawer";
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
  const panel = (
    <aside aria-label={t("assistantDesktop.title")} className="h-full">
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
  );

  if (isMobile) {
    return (
      <div
        id="assistant-desktop-sidebar"
        className="absolute inset-0 z-20 min-h-0 bg-[var(--surface-base)] p-2"
      >
        {panel}
      </div>
    );
  }

  return (
    <AnimatedRightDrawer
      open
      animateOnMount
      right={panel}
      defaultWidth={400}
      minWidth={280}
      minLeftWidth={328}
      storageKey="desktop-sidebar-width"
      paneId="assistant-desktop-sidebar"
      resizeLabel={t("assistantDesktop.resizeAria")}
    />
  );
}
