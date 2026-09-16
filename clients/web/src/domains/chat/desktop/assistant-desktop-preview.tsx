import { AnimatePresence } from "motion/react";
import { lazy, useEffect } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { usePointerCoarse } from "@/utils/pointer";

import { DesktopPreviewFrame } from "./desktop-preview-frame";
import { useDesktopPreviewStore } from "./desktop-preview-store";
import { useVirtualDesktopEnabled } from "./use-virtual-desktop-enabled";

const DesktopPreviewContent = lazy(() =>
  import("./desktop-preview-content").then((module) => ({
    default: module.DesktopPreviewContent,
  })),
);

export function AssistantDesktopPreview() {
  const enabled = useVirtualDesktopEnabled();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const session = useDesktopPreviewStore.use.session();
  const inlinePreview = useDesktopPreviewStore.use.inlinePreview();
  const fullscreenOnly = usePointerCoarse();

  useEffect(() => {
    return () => useDesktopPreviewStore.getState().close();
  }, [assistantId, enabled]);

  if (enabled !== true || assistantId === null) {
    return null;
  }

  const inlineContainer =
    inlinePreview?.assistantId === assistantId ? inlinePreview.container : null;
  const fullscreen =
    session?.assistantId === assistantId &&
    (session.view === "fullscreen" || (!inlineContainer && fullscreenOnly));

  return (
    <AnimatePresence initial={false} key={assistantId}>
      {(session?.assistantId === assistantId || inlineContainer) && (
        <DesktopPreviewFrame
          key={assistantId}
          fullscreen={Boolean(inlineContainer) || fullscreen}
        >
          <LazyBoundary>
            <DesktopPreviewContent
              assistantId={assistantId}
              fullscreen={fullscreen}
              fullscreenOnly={fullscreenOnly}
              previewContainer={inlineContainer}
            />
          </LazyBoundary>
        </DesktopPreviewFrame>
      )}
    </AnimatePresence>
  );
}
