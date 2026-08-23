import { Menu, X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { Button } from "@vellumai/design-library";

import { useBodyScrollLock } from "@/hooks/use-body-scroll-lock";
import { useSwipeHorizontal } from "@/hooks/use-swipe-horizontal";
import { useTranslation } from "@/i18n";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface SideListDrawerProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title: string;
}

/**
 * Full-screen overlay drawer holding a list-detail pane's list while the pane
 * is too narrow to seat it beside the detail. Uses body scroll lock,
 * Escape-to-close, and a focus trap.
 *
 * The drawer never decides for itself whether it applies: `useSideListRoom()`
 * owns that one boolean for both this and the inline list it substitutes for,
 * and this is mounted only while the substitution is on. Hiding it in CSS
 * instead would put the threshold in two places, and the gap between them is a
 * width where the list has no surface at all. See
 * `docs/PLATFORM_ADAPTATION.md`.
 */
export function SideListDrawer({
  open,
  onClose,
  children,
  title,
}: SideListDrawerProps) {
  const { t } = useTranslation();
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Swipe right-to-left on the panel to close. Complements the backdrop tap
  // and the close button: all three call the same onClose.
  const {
    dragOffset,
    isDragging,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  } = useSwipeHorizontal({
    enabled: open,
    onSwipeLeft: onClose,
  });

  useBodyScrollLock(open);

  useEffect(() => {
    if (!open) {
      return;
    }
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) {
        return;
      }
      const focusable =
        drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const isInDrawer = drawerRef.current.contains(active);

      if (event.shiftKey) {
        if (!isInDrawer || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!isInDrawer || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      ref={drawerRef}
      className="fixed inset-0"
      style={{ zIndex: 40 }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        aria-label={t("sideListDrawer.closeSidebarAria")}
        className="absolute inset-0 h-full w-full cursor-default"
        style={{ background: "rgba(0, 0, 0, 0.4)", zIndex: 40 }}
        onClick={onClose}
      />
      <aside
        className="relative flex h-full w-[80vw] max-w-xs flex-col shadow-xl"
        style={{
          background: "var(--surface-lift)",
          borderRight: "1px solid var(--border-base)",
          zIndex: 50,
          paddingTop:
            "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
          paddingBottom:
            "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
          paddingLeft:
            "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
          // Follow the finger during a swipe-to-close; spring back on
          // release (transition re-enabled when not dragging).
          transform: `translateX(${dragOffset}px)`,
          transition: isDragging ? "none" : "transform 200ms ease-out",
          // Claim horizontal gestures for the swipe; let the browser handle
          // vertical scrolling of the drawer content natively.
          touchAction: "pan-y",
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        <div
          className="flex shrink-0 items-center justify-between border-b px-4 py-3"
          style={{ borderColor: "var(--border-base)" }}
        >
          <span
            className="text-title-small"
            style={{ color: "var(--content-default)" }}
          >
            {title}
          </span>
          <Button
            ref={closeButtonRef}
            type="button"
            variant="ghost"
            size="compact"
            iconOnly={<X aria-hidden />}
            onClick={onClose}
            aria-label={t("sideListDrawer.closeAria")}
            tintColor="var(--content-tertiary)"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>
  );
}

/**
 * Hamburger-menu button that opens {@link SideListDrawer}. Rendered by the
 * same owner, on the same signal, so it exists exactly when the inline list
 * does not.
 */
export function SideListTrigger({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();

  return (
    <Button
      type="button"
      variant="ghost"
      iconOnly={<Menu aria-hidden />}
      onClick={onClick}
      aria-label={t("sideListDrawer.openSidebarAria")}
      tintColor="var(--content-secondary)"
    />
  );
}
