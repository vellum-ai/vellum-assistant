import { Button, Modal } from "@vellumai/design-library";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { PreviewModalHeader } from "@/domains/chat/components/preview-modal-header";
import { useTranslation } from "@/i18n";
import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";
import { cn } from "@/utils/misc";

import { DesktopPanel } from "./desktop-panel";
import { useDesktopPreviewStore } from "./desktop-preview-store";

interface DesktopPreviewContentProps {
  assistantId: string;
  fullscreen: boolean;
  fullscreenOnly: boolean;
}

export function DesktopPreviewContent({
  assistantId,
  fullscreen,
  fullscreenOnly,
}: DesktopPreviewContentProps) {
  const { t } = useTranslation("chat");
  const previewRef = useRef<HTMLDivElement>(null);
  // A stable portal host keeps the live session mounted across both surfaces.
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "h-full w-full";
    return element;
  });
  const attachPreview = useCallback(
    (node: HTMLDivElement | null) => {
      previewRef.current = node;
      node?.appendChild(host);
    },
    [host],
  );
  const attachFullscreen = useCallback(
    (node: HTMLDivElement | null) => {
      (node ?? previewRef.current)?.appendChild(host);
    },
    [host],
  );
  const setFullscreen = (open: boolean) => {
    const store = useDesktopPreviewStore.getState();
    if (!open && fullscreenOnly) {
      store.close();
    } else {
      store.setFullscreen(open);
    }
  };

  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const { registerBackOwner, unregisterBackOwner } =
      useEdgeSwipeArbiterStore.getState();
    registerBackOwner();
    return () => unregisterBackOwner();
  }, [fullscreen]);

  return (
    <>
      <div className="relative aspect-video w-full overflow-hidden bg-black">
        <div
          ref={attachPreview}
          inert={!fullscreen}
          className="h-full w-full"
        />
        <Button
          variant="ghost"
          aria-label={t("assistantDesktop.expandAria")}
          onClick={() => setFullscreen(true)}
          className="absolute inset-0 h-full w-full cursor-zoom-in rounded-none bg-transparent hover:bg-transparent active:scale-100"
        />
      </div>
      {createPortal(
        <DesktopPanel assistantId={assistantId} viewOnly={!fullscreen} />,
        host,
      )}
      <Modal.Root open={fullscreen} onOpenChange={setFullscreen}>
        <Modal.Content
          id="assistant-desktop-modal"
          hideCloseButton
          aria-describedby={undefined}
          className="h-dvh max-h-none max-w-none rounded-none border-0 bg-transparent shadow-none"
          overlayClassName="bg-black/80 p-0 [-webkit-app-region:no-drag]"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // The stable portal is outside the dialog's React ancestry.
            if (event.target instanceof Node && host.contains(event.target)) {
              event.preventDefault();
            }
          }}
          onCloseAutoFocus={(event) => {
            if (fullscreenOnly) {
              return;
            }
            event.preventDefault();
            previewRef.current?.parentElement
              ?.querySelector<HTMLButtonElement>("button")
              ?.focus();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setFullscreen(false);
            }
          }}
        >
          <Modal.Title className="sr-only">
            {t("assistantDesktop.title")}
          </Modal.Title>
          <PreviewModalHeader
            title={t("assistantDesktop.title")}
            onClose={() => setFullscreen(false)}
          />
          <div
            ref={attachFullscreen}
            className={cn(
              "pointer-events-auto mx-auto min-h-0 flex-1 overflow-hidden",
              fullscreenOnly ? "w-full" : "w-[90vw] rounded-lg",
            )}
            style={{
              marginTop:
                "calc(4rem + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
              marginBottom:
                "calc(1rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
            }}
          />
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
