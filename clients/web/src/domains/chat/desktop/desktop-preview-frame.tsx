import { Button } from "@vellumai/design-library";
import { GripHorizontal, Monitor, MoveDiagonal2, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import { useTranslation } from "@/i18n";

import { useDesktopPreviewStore } from "./desktop-preview-store";
import { useDesktopPreviewDrag } from "./use-desktop-preview-drag";

export function DesktopPreviewFrame({
  children,
  fullscreen,
}: {
  children: ReactNode;
  fullscreen: boolean;
}) {
  const { t } = useTranslation("chat");
  const close = useDesktopPreviewStore.use.close();
  const viewportStyle = useMobileOverlayViewportStyle();
  const reduce = useReducedMotion();
  const {
    boundsRef,
    frameRef,
    position,
    width,
    onMoveKeyDown,
    onResizeKeyDown,
    ...dragProps
  } = useDesktopPreviewDrag();

  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 z-30 flex"
      style={viewportStyle}
    >
      <div
        ref={boundsRef}
        className="relative m-4 min-h-0 flex-1 [container-type:size]"
      >
        <motion.aside
          {...dragProps}
          ref={frameRef}
          id="assistant-desktop-preview"
          aria-label={t("assistantDesktop.title")}
          className="pointer-events-auto absolute flex max-w-full touch-none select-none flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] shadow-2xl [-webkit-app-region:no-drag]"
          style={{
            width: `min(${width}px, 100cqw, calc((100cqh - 2.625rem) * 16 / 9))`,
            left: position?.x,
            top: position?.y,
            right: position ? undefined : 0,
            bottom: position ? undefined : 0,
            visibility: fullscreen ? "hidden" : "visible",
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.15 }}
        >
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border-base)] pl-6 pr-1 transition-colors hover:bg-[color-mix(in_srgb,var(--primary-second-hover)_15%,transparent)]">
            <Button
              variant="ghost"
              size="regular"
              expandOnMobile={false}
              leftIcon={<Monitor className="size-4" />}
              rightIcon={
                <GripHorizontal className="ml-auto size-4 text-[var(--content-tertiary)]" />
              }
              aria-label={t("assistantDesktop.moveAria")}
              className="min-w-0 flex-1 cursor-grab hover:bg-transparent active:cursor-grabbing active:scale-100 active:bg-transparent"
              onKeyDown={onMoveKeyDown}
              onClick={() =>
                useDesktopPreviewStore.getState().setFullscreen(true)
              }
            >
              {t("assistantDesktop.title")}
            </Button>
            <Button
              variant="ghost"
              size="regular"
              expandOnMobile={false}
              iconOnly={<X />}
              aria-label={t("assistantDesktop.closeAria")}
              data-desktop-close
              onClick={close}
            />
          </div>
          <Button
            variant="ghost"
            size="compact"
            expandOnMobile={false}
            iconOnly={<MoveDiagonal2 className="size-3" />}
            aria-label={t("assistantDesktop.resizeAria")}
            title={t("assistantDesktop.resizeAria")}
            data-desktop-resize
            className="absolute left-0 top-0 z-10 size-6 cursor-nwse-resize rounded-none active:scale-100"
            onKeyDown={onResizeKeyDown}
          />
          {children}
        </motion.aside>
      </div>
    </div>,
    document.getElementById("viewport-overlays") ?? document.body,
  );
}
