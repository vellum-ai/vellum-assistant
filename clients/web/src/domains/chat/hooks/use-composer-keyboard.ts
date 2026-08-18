/**
 * Consolidates keyboard-focus behaviors for the chat composer textarea:
 *
 * 1. **Host focus relay** — listens for `COMPOSER_FOCUS_EVENT` window
 *    events dispatched by the `useVellumCommands` hook in `chat-layout.tsx`
 *    (File > Current Conversation / New Chat). Also claims any pending
 *    focus request that fired before this component mounted (e.g. the
 *    command was invoked from `/assistant/home` and chat-layout navigated
 *    here). Keeps reclaiming for a short window so a new-chat remount
 *    cannot drop the caret back to `<body>`.
 *
 * 2. **Typing auto-focus** — when the user starts typing with no focused
 *    input and no modal open, captures the keypress and forwards it to
 *    the composer, focusing the textarea first.
 */

import { type MutableRefObject, useEffect } from "react";

import {
  COMPOSER_FOCUS_EVENT,
  insertTextAtSelection,
  isComposerFocusPending,
  shouldFocusComposerForTyping,
  tryClaimComposerFocus,
} from "@/domains/chat/composer-focus";
import { useComposerStore } from "@/domains/chat/composer-store";

export function useComposerKeyboard(
  inputRef: MutableRefObject<HTMLTextAreaElement | null>,
): void {
  // 1. Host focus relay + pending-focus claim loop.
  useEffect(() => {
    let raf = 0;
    const claim = () => {
      tryClaimComposerFocus(inputRef.current);
    };
    const tick = () => {
      claim();
      if (isComposerFocusPending()) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    };
    const startClaimLoop = () => {
      if (raf !== 0) {
        return;
      }
      tick();
    };

    window.addEventListener(COMPOSER_FOCUS_EVENT, startClaimLoop);
    if (isComposerFocusPending()) {
      startClaimLoop();
    }
    return () => {
      window.removeEventListener(COMPOSER_FOCUS_EVENT, startClaimLoop);
      cancelAnimationFrame(raf);
    };
  }, [inputRef]);

  // 2. Typing auto-focus — redirect keypresses to the composer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const inputEl = inputRef.current;
      if (!inputEl || inputEl.disabled || inputEl.readOnly) {
        return;
      }
      if (document.activeElement === inputEl) {
        return;
      }
      if (document.querySelector('[aria-modal="true"]')) {
        return;
      }
      if (!shouldFocusComposerForTyping(event, document.activeElement)) {
        return;
      }

      event.preventDefault();
      inputEl.focus();
      useComposerStore.getState().setInput((current) => {
        const next = insertTextAtSelection({
          value: current,
          text: event.key,
          selectionStart: inputEl.selectionStart,
          selectionEnd: inputEl.selectionEnd,
        });
        requestAnimationFrame(() => {
          inputEl.setSelectionRange(next.cursor, next.cursor);
        });
        return next.value;
      });
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [inputRef]);
}
