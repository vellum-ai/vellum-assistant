import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { BottomSheet } from "@vellumai/design-library";
import { PortalContainerProvider } from "@vellumai/design-library/utils/portal-container";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import { useTranslation } from "@/i18n";
import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";

interface MobileDetailSheetProps<T> {
  data: T | null;
  onClose: () => void;
  children: (data: T) => ReactNode;
  testId?: string;
}

/** Keeps the exiting panel alive until Radix finishes the sheet's animation. */
function RetainedDetail<T>({
  data,
  children,
}: Pick<MobileDetailSheetProps<T>, "data" | "children">) {
  const registerBackOwner = useEdgeSwipeArbiterStore.use.registerBackOwner();
  const unregisterBackOwner =
    useEdgeSwipeArbiterStore.use.unregisterBackOwner();
  useEffect(() => {
    registerBackOwner();
    return unregisterBackOwner;
  }, [registerBackOwner, unregisterBackOwner]);
  const [retained, setRetained] = useState(data);
  if (data !== null && data !== retained) {
    setRetained(data);
  }
  const current = data ?? retained;
  return current === null ? null : (
    <LazyBoundary>{children(current)}</LazyBoundary>
  );
}

export function MobileDetailSheet<T>({
  data,
  onClose,
  children,
  testId,
}: MobileDetailSheetProps<T>) {
  const { t } = useTranslation("chat");
  const viewportStyle = useMobileOverlayViewportStyle();
  const contentRef = useRef<HTMLDivElement>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const setContentRef = useCallback((element: HTMLDivElement | null) => {
    contentRef.current = element;
    setPortalContainer(element);
  }, []);
  const triggerRef = useRef<HTMLElement | null>(null);
  const conversationRef = useRef<HTMLElement | null>(null);

  return (
    <BottomSheet.Root
      open={data !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <BottomSheet.Content
        ref={setContentRef}
        variant="detail"
        padded={false}
        style={
          {
            ...viewportStyle,
            "--bottom-sheet-bottom-inset": viewportStyle.paddingBottom,
          } as CSSProperties
        }
        data-testid={testId}
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          const dialog =
            event.target instanceof Element
              ? event.target.closest('[role="dialog"]')
              : null;
          if (dialog && dialog !== contentRef.current) {
            event.preventDefault();
          }
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const content = contentRef.current;
          const active = document.activeElement;
          const trigger =
            active instanceof HTMLElement &&
            active.hasAttribute("data-detail-sheet-trigger")
              ? active
              : null;
          triggerRef.current = trigger;
          conversationRef.current = document.querySelector<HTMLElement>(
            '[data-slot="chat-body"]',
          );
          const surface = content?.querySelector<HTMLElement>(
            '[data-slot="bottom-sheet-content-inner"]',
          );
          if (content && surface && trigger) {
            const origin = trigger.getBoundingClientRect().top;
            const restingTop = content.offsetTop + surface.offsetTop;
            content.style.setProperty(
              "--bottom-sheet-origin-y",
              `${Math.max(0, Math.min(content.clientHeight, origin - restingTop))}px`,
            );
          }
          content?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const anotherDialog = Array.from(
            document.querySelectorAll<HTMLElement>('[role="dialog"]'),
          ).some(
            (dialog) =>
              dialog !== contentRef.current &&
              dialog.dataset.state !== "closed",
          );
          if (anotherDialog) {
            return;
          }
          const target = triggerRef.current?.isConnected
            ? triggerRef.current
            : conversationRef.current;
          if (target?.isConnected) {
            target.focus({ preventScroll: true });
          }
        }}
      >
        <BottomSheet.Title className="sr-only">
          {t("mobileDetailSheet.title")}
        </BottomSheet.Title>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&_[data-slot=detail-shell]]:rounded-none">
          <PortalContainerProvider container={portalContainer}>
            <RetainedDetail data={data}>{children}</RetainedDetail>
          </PortalContainerProvider>
        </div>
      </BottomSheet.Content>
    </BottomSheet.Root>
  );
}
