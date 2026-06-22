import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Manages the mobile drawer overlay: focus trap (Tab cycling + ESC dismiss)
 * and body scroll lock while visible.
 *
 * Returns a ref to attach to the drawer container element.
 */
export function useChatLayoutDrawer({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}): RefObject<HTMLDivElement | null> {
  const drawerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }

    drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        drawerRef.current &&
        !drawerRef.current.contains(document.activeElement)
      ) {
        return;
      }

      if (event.key === "Escape") {
        onClose();
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
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [visible, onClose]);

  return drawerRef;
}
