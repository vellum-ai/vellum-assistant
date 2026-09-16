import { Button } from "@vellumai/design-library";
import { GripHorizontal, Monitor, X } from "lucide-react";
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
  const { boundsRef, frameRef, position, onMoveKeyDown, ...dragProps } =
    useDesktopPreviewDrag();

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
          className="pointer-events-auto absolute flex w-[min(20rem,100cqw,calc((100cqh_-_2.625rem)_*_16_/_9))] max-w-full touch-none select-none flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] shadow-2xl [-webkit-app-region:no-drag]"
          style={{
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
          <div className="grid h-10 shrink-0 grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-1 border-b border-[var(--border-base)] px-1 transition-colors hover:bg-[color-mix(in_srgb,var(--primary-second-hover)_15%,transparent)]">
            <GripHorizontal className="size-4 justify-self-center text-[var(--content-tertiary)]" />
            <Button
              variant="ghost"
              size="regular"
              leftIcon={<Monitor className="size-4" />}
              aria-label={t("assistantDesktop.moveAria")}
              className="min-w-0 cursor-grab justify-center hover:bg-transparent active:cursor-grabbing active:scale-100 active:bg-transparent"
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
          {children}
        </motion.aside>
      </div>
    </div>,
    document.getElementById("viewport-overlays") ?? document.body,
  );
}
