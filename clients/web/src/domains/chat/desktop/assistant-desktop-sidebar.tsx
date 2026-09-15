import { lazy, useEffect } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useTranslation } from "@/i18n";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { useDesktopSidebarStore } from "./desktop-sidebar-store";

const DesktopSidebarContent = lazy(() =>
  import("./desktop-sidebar-content").then((module) => ({
    default: module.DesktopSidebarContent,
  })),
);

export function AssistantDesktopSidebar() {
  const { t } = useTranslation("chat");
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
    <aside
      id="assistant-desktop-sidebar"
      aria-label={t("assistantDesktop.title")}
      className="absolute inset-0 z-20 overflow-y-auto rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] p-4 md:static md:w-[clamp(280px,32vw,560px)] md:shrink-0"
    >
      <LazyBoundary>
        <DesktopSidebarContent
          key={assistantId}
          assistantId={session.assistantId}
          fullscreen={session.view === "fullscreen"}
        />
      </LazyBoundary>
    </aside>
  );
}
