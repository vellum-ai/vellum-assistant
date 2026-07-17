import { Menu, X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { Button } from "@vellumai/design-library";

import { useSwipeHorizontal } from "@/hooks/use-swipe-horizontal";

/** Tailwind `sm` breakpoint — matches the `sm:hidden` class on the drawer. */
const SM_MEDIA_QUERY = "(min-width: 640px)";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface MobileSidebarDrawerProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title: string;
}

/**
 * Full-screen overlay drawer for Kit section sidebars on small screens
 * (< 640px). Uses body scroll lock, Escape-to-close, and a focus trap.
 * Hidden at the sm breakpoint and above via CSS.
 */
export function MobileSidebarDrawer({
  open,
  onClose,
  children,
  title,
}: MobileSidebarDrawerProps) {
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Swipe right-to-left on the panel to close. Complements the backdrop tap
  // and the close button — all three call the same onClose.
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

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const mql = window.matchMedia(SM_MEDIA_QUERY);
    const handleMediaChange = (e: MediaQueryListEvent) => {
      if (e.matches) onCloseRef.current();
    };
    mql.addEventListener("change", handleMediaChange);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) {
        return;
      }
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      );
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
      mql.removeEventListener("change", handleMediaChange);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={drawerRef}
      className="fixed inset-0 sm:hidden"
      style={{ zIndex: 40 }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        aria-label="Close sidebar"
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
            aria-label="Close"
            tintColor="var(--content-tertiary)"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>
  );
}

/**
 * Hamburger-menu button that opens the mobile sidebar drawer. Hidden at
 * the sm breakpoint and above.
 */
export function MobileSidebarTrigger({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      iconOnly={<Menu aria-hidden />}
      onClick={onClick}
      aria-label="Open sidebar"
      tintColor="var(--content-secondary)"
      className="sm:hidden"
    />
  );
}
