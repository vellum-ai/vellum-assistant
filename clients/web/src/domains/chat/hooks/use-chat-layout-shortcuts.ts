import { useEffect } from "react";

import { openCommandPaletteWindow } from "@/runtime/command-palette-window";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

/**
 * Returns `true` when the keyboard event matches the requested modifier plus
 * one of the given keys and the active element is not an input surface.
 */
export function shouldHandleShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "key" | "code">,
  activeElement: Element | null,
  key: string | string[],
  modifier: "command" | "alt" = "command",
): boolean {
  const modifierPressed =
    modifier === "alt" ? event.altKey : event.metaKey || event.ctrlKey;
  if (!modifierPressed) {
    return false;
  }
  const keys = Array.isArray(key) ? key : [key];
  const keyMatches = keys.some(
    (candidate) =>
      candidate.toLowerCase() === event.key.toLowerCase() ||
      `Key${candidate.toUpperCase()}` === event.code,
  );
  if (!keyMatches) {
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
 * - Ctrl/Cmd+Shift+O → new conversation (ChatGPT / Claude convention)
 * - Option/Alt+Z → toggle Voice Mode
 * - Ctrl/Cmd+\ → toggle sidebar
 * - Ctrl/Cmd+K → toggle command palette
 * - Ctrl/Cmd+[ → navigate back
 * - Ctrl/Cmd+] → navigate forward
 */
export function useChatLayoutShortcuts({
  toggleSidebar,
  onGoBack,
  onGoForward,
  onNewConversation,
  onToggleVoiceMode,
}: {
  toggleSidebar: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onNewConversation: () => void;
  onToggleVoiceMode: () => void;
}): void {
  useEffect(() => {
    const toggle = useCommandPaletteStore.getState().toggle;
    const openCommandPalette = () => {
      void openCommandPaletteWindow()
        .then((opened) => {
          if (!opened) {
            toggle();
          }
        })
        .catch(() => {
          toggle();
        });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Cmd/Ctrl+Shift+O → new conversation. Checked before the
      // input-element guard so it fires from the composer too,
      // matching ChatGPT / Claude behavior.
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        onNewConversation();
        return;
      }

      // Option/Alt+Z toggles Voice Mode. Match the physical Z key because
      // macOS reports Option+Z as Ω on a US keyboard, and yield to text entry.
      if (shouldHandleShortcut(event, document.activeElement, "z", "alt")) {
        event.preventDefault();
        onToggleVoiceMode();
        return;
      }

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
        if (event.key === "[") {
          onGoBack();
        } else if (event.key === "]") {
          onGoForward();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    toggleSidebar,
    onGoBack,
    onGoForward,
    onNewConversation,
    onToggleVoiceMode,
  ]);
}
