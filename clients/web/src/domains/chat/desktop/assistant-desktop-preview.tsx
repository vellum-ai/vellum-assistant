import { AnimatePresence } from "motion/react";
import { lazy, useEffect } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { DesktopPreviewFrame } from "./desktop-preview-frame";
import { useDesktopPreviewStore } from "./desktop-preview-store";

const DesktopPreviewContent = lazy(() =>
  import("./desktop-preview-content").then((module) => ({
    default: module.DesktopPreviewContent,
  })),
);

export function AssistantDesktopPreview() {
  const enabled = useAssistantFeatureFlagStore.use.assistantDesktop();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const session = useDesktopPreviewStore.use.session();

  useEffect(() => {
    return () => useDesktopPreviewStore.getState().close();
  }, [assistantId, enabled]);

  if (enabled !== true || assistantId === null) {
    return null;
  }

  return (
    <AnimatePresence initial={false} key={assistantId}>
      {session?.assistantId === assistantId && (
        <DesktopPreviewFrame key={assistantId}>
          <LazyBoundary>
            <DesktopPreviewContent
              assistantId={session.assistantId}
              fullscreen={session.view === "fullscreen"}
            />
          </LazyBoundary>
        </DesktopPreviewFrame>
      )}
    </AnimatePresence>
  );
}
