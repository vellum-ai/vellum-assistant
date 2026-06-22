import { useEffect } from "react";

import { openCommandPaletteWindow } from "@/runtime/command-palette-window";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

/**
 * Returns `true` when the keyboard event matches Ctrl/Cmd + one of the given
 * keys and the active element is not an input surface.
 */
function shouldHandleShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">,
  activeElement: Element | null,
  key: string | string[],
): boolean {
  const modifierPressed = event.metaKey || event.ctrlKey;
  if (!modifierPressed) {
    return false;
  }
  const keys = Array.isArray(key) ? key : [key];
  if (!keys.includes(event.key)) {
    return false;
  }
  if (!activeElement) {
    return true;
  }
  const tag = activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return false;
  }
  if (activeElement.getAttribute("contenteditable") === "true") {
    return false;
  }
  return true;
}

/**
 * Registers global keyboard shortcuts for the chat layout:
 * - Ctrl/Cmd+\ → toggle sidebar
 * - Ctrl/Cmd+K → toggle command palette
 * - Ctrl/Cmd+[ → navigate back
 * - Ctrl/Cmd+] → navigate forward
 */
export function useChatLayoutShortcuts({
  toggleSidebar,
  onGoBack,
  onGoForward,
}: {
  toggleSidebar: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
}): void {
  useEffect(() => {
    const toggle = useCommandPaletteStore.getState().toggle;
    const openCommandPalette = () => {
      void openCommandPaletteWindow()
        .then((opened) => {
          if (!opened) toggle();
        })
        .catch(() => {
          toggle();
        });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldHandleShortcut(event, document.activeElement, "\\")) {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (shouldHandleShortcut(event, document.activeElement, "k")) {
        event.preventDefault();
        openCommandPalette();
        return;
      }
      if (shouldHandleShortcut(event, document.activeElement, ["[", "]"])) {
        event.preventDefault();
        if (event.key === "[") onGoBack();
        else if (event.key === "]") onGoForward();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [toggleSidebar, onGoBack, onGoForward]);
}
