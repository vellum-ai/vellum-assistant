import { Modal, Typography } from "@vellumai/design-library";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { PreviewModalHeader } from "@/domains/chat/components/preview-modal-header";
import { useTranslation } from "@/i18n";
import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";

import { DesktopPanel } from "./desktop-panel";
import { useDesktopSidebarStore } from "./desktop-sidebar-store";

interface DesktopSidebarContentProps {
  assistantId: string;
  fullscreen: boolean;
}

export function DesktopSidebarContent({
  assistantId,
  fullscreen,
}: DesktopSidebarContentProps) {
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
  const setFullscreen = (open: boolean) =>
    useDesktopSidebarStore.getState().setFullscreen(open);

  useEffect(() => {
    const { registerBackOwner, unregisterBackOwner } =
      useEdgeSwipeArbiterStore.getState();
    registerBackOwner();
    return () => unregisterBackOwner();
  }, []);

  return (
    <>
      <div
        ref={attachPreview}
        className="aspect-video w-full overflow-hidden rounded-lg border border-[var(--border-base)] bg-black"
      />
      <Typography
        as="p"
        variant="body-small-default"
        className="mt-3 text-center text-[var(--content-tertiary)]"
      >
        {t("assistantDesktop.title")}
      </Typography>
      {createPortal(
        <DesktopPanel
          assistantId={assistantId}
          viewOnly={!fullscreen}
          onExpand={() => setFullscreen(true)}
        />,
        host,
      )}
      <Modal.Root open={fullscreen} onOpenChange={setFullscreen}>
        <Modal.Content
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
            event.preventDefault();
            previewRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setFullscreen(false);
            }
          }}
        >
          <Modal.Title className="sr-only">{t("assistantDesktop.title")}</Modal.Title>
          <PreviewModalHeader
            title={t("assistantDesktop.title")}
            onClose={() => setFullscreen(false)}
          />
          <div
            ref={attachFullscreen}
            className="pointer-events-auto mx-auto min-h-0 w-[90vw] flex-1 overflow-hidden rounded-lg"
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
