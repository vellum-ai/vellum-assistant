import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { BottomSheet } from "@vellumai/design-library";

import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import { useTranslation } from "@/i18n";
import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";

interface WorkspaceFilePickerProps {
  open: boolean;
  onClose: () => void;
  pickerId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}

export function WorkspaceFilePicker({
  open,
  onClose,
  pickerId,
  triggerRef,
  children,
}: WorkspaceFilePickerProps) {
  const { t } = useTranslation("workspace");
  const viewportStyle = useMobileOverlayViewportStyle();
  const contentRef = useRef<HTMLDivElement>(null);
  const registerBackOwner = useEdgeSwipeArbiterStore.use.registerBackOwner();
  const unregisterBackOwner =
    useEdgeSwipeArbiterStore.use.unregisterBackOwner();
  useEffect(() => {
    if (open) {
      registerBackOwner();
      return unregisterBackOwner;
    }
  }, [open, registerBackOwner, unregisterBackOwner]);

  return (
    <BottomSheet.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <BottomSheet.Content
        ref={contentRef}
        id={pickerId}
        variant="detail"
        dragHandleLabel={t("workspaceFilePicker.dismiss")}
        padded={false}
        className="workspace-file-picker"
        overlayClassName="workspace-file-picker-overlay"
        style={
          {
            ...viewportStyle,
            "--bottom-sheet-bottom-inset": viewportStyle.paddingBottom,
          } as CSSProperties
        }
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => {
          const dialog =
            event.target instanceof Element
              ? event.target.closest('[role="dialog"]')
              : null;
          if (dialog && dialog !== contentRef.current) {
            event.preventDefault();
          }
        }}
      >
        {children}
      </BottomSheet.Content>
    </BottomSheet.Root>
  );
}
