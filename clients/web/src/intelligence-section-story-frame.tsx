import type { ReactNode } from "react";
import { Route, Routes } from "react-router";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { ChatLayoutHeader } from "@/domains/chat/chat-layout-header";
import { IntelligenceLayout } from "@/domains/intelligence/intelligence-layout";
import { useIsMobile } from "@/hooks/use-is-mobile";

interface IntelligenceSectionStoryFrameProps {
  path: string;
  outlet: ReactNode;
}

/** The real section layout and chat header, connected through their slots. */
export function IntelligenceSectionStoryFrame({
  path,
  outlet,
}: IntelligenceSectionStoryFrameProps) {
  const isMobile = useIsMobile();
  const mobileTopBar = useChatLayoutSlotsStore.use.mobileTopBar();
  const topBarCenter = useChatLayoutSlotsStore.use.topBarCenter();

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[var(--surface-overlay)]">
      <ChatLayoutHeader
        isMobile={isMobile}
        drawerOpen={false}
        collapsed
        toggleSidebar={() => {}}
        mobileTopBar={mobileTopBar}
        topBarCenter={topBarCenter}
      />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Routes>
          <Route element={<IntelligenceLayout />}>
            <Route path={path} element={outlet} />
          </Route>
        </Routes>
      </main>
    </div>
  );
}
