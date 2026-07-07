/**
 * Bridges the Capacitor iOS shell's native text-selection edit-menu "Reply"
 * item to the web quote-and-reply flow.
 *
 * The native shell (`MyViewController.swift`) inserts a "Reply" item into the
 * WKWebView selection edit menu and, when tapped, calls
 * `window.__vellumQuoteReplyFromSelection()`. This hook:
 *
 * 1. Registers that global, which resolves the current selection to an
 *    assistant message and opens the reply bubble — reusing the same
 *    resolution logic as the web floating chip (`resolveAssistantSelection`).
 * 2. Posts `{ canReply }` to the `vellumTextSelection` script-message handler
 *    on every `selectionchange`, so native can gate the menu item to
 *    assistant-message selections only.
 *
 * No-op outside the Capacitor shell. The wire contract is intentionally
 * minimal (one window global + one message-handler name) and resilient to
 * native/web version skew: an older native shell simply never calls the
 * global, and an older web bundle just never registers it.
 */

import { type RefObject, useEffect } from "react";

import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import { resolveAssistantSelection } from "@/domains/chat/resolve-assistant-selection";
import { isNativePlatform } from "@/runtime/native-auth";

const NATIVE_SELECTION_HANDLER = "vellumTextSelection";

declare global {
  interface Window {
    __vellumQuoteReplyFromSelection?: () => void;
    webkit?: {
      messageHandlers?: Record<
        string,
        { postMessage: (message: unknown) => void } | undefined
      >;
    };
  }
}

export function useNativeQuoteReply(
  containerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!isNativePlatform()) {
      return;
    }

    const openFromSelection = () => {
      const resolved = resolveAssistantSelection(containerRef.current);
      if (!resolved) {
        return;
      }
      useQuoteReplyStore.getState().openReplyBubble({
        quotedText: resolved.text,
        sourceMessageId: resolved.messageId,
        anchorRect: {
          top: resolved.rect.top,
          left: resolved.rect.left + resolved.rect.width / 2,
          width: 0,
          height: 0,
        },
      });
      window.getSelection()?.removeAllRanges();
    };

    const postCanReply = () => {
      const handler = window.webkit?.messageHandlers?.[NATIVE_SELECTION_HANDLER];
      if (!handler) {
        return;
      }
      handler.postMessage({
        canReply: resolveAssistantSelection(containerRef.current) !== null,
      });
    };

    window.__vellumQuoteReplyFromSelection = openFromSelection;
    document.addEventListener("selectionchange", postCanReply);
    return () => {
      document.removeEventListener("selectionchange", postCanReply);
      if (window.__vellumQuoteReplyFromSelection === openFromSelection) {
        delete window.__vellumQuoteReplyFromSelection;
      }
    };
  }, [containerRef]);
}
