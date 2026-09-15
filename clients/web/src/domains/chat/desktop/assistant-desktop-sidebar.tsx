import { lazy, useEffect } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { DesktopSidebarFrame } from "./desktop-sidebar-frame";
import { useDesktopSidebarStore } from "./desktop-sidebar-store";

const DesktopSidebarContent = lazy(() =>
  import("./desktop-sidebar-content").then((module) => ({
    default: module.DesktopSidebarContent,
  })),
);

export function AssistantDesktopSidebar() {
  const enabled = useAssistantFeatureFlagStore.use.assistantDesktop();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const session = useDesktopSidebarStore.use.session();

  useEffect(() => {
    return () => useDesktopSidebarStore.getState().close();
  }, [assistantId, enabled]);

  if (enabled !== true || !session || session.assistantId !== assistantId) {
    return null;
  }

  return (
    <DesktopSidebarFrame>
      <LazyBoundary>
        <DesktopSidebarContent
          key={assistantId}
          assistantId={session.assistantId}
          fullscreen={session.view === "fullscreen"}
        />
      </LazyBoundary>
    </DesktopSidebarFrame>
  );
}
