/**
 * Consolidates keyboard-focus behaviors for the chat composer textarea:
 *
 * 1. **Electron host focus** — listens for `COMPOSER_FOCUS_EVENT` window
 *    events dispatched by the `useVellumCommands` hook in `chat-layout.tsx`
 *    (File > Current Conversation menu). Also drains any pending focus
 *    request that fired before this component mounted (e.g. the command
 *    was invoked from `/assistant/home` and chat-layout navigated here).
 *
 * 2. **Typing auto-focus** — when the user starts typing with no focused
 *    input and no modal open, captures the keypress and forwards it to
 *    the composer, focusing the textarea first.
 */

import { type MutableRefObject, useEffect } from "react";

import {
  COMPOSER_FOCUS_EVENT,
  consumePendingComposerFocus,
  insertTextAtSelection,
  shouldFocusComposerForTyping,
} from "@/domains/chat/composer-focus";
import { useComposerStore } from "@/domains/chat/composer-store";

export function useComposerKeyboard(
  inputRef: MutableRefObject<HTMLTextAreaElement | null>,
): void {
  // 1. Electron host focus relay + pending-focus drain.
  useEffect(() => {
    const focusInput = () => inputRef.current?.focus();
    const handleFocusRequest = () => {
      consumePendingComposerFocus();
      focusInput();
    };
    window.addEventListener(COMPOSER_FOCUS_EVENT, handleFocusRequest);
    if (consumePendingComposerFocus()) {
      queueMicrotask(focusInput);
    }
    return () =>
      window.removeEventListener(COMPOSER_FOCUS_EVENT, handleFocusRequest);
  }, [inputRef]);

  // 2. Typing auto-focus — redirect keypresses to the composer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const inputEl = inputRef.current;
      if (!inputEl || inputEl.disabled || inputEl.readOnly) return;
      if (document.activeElement === inputEl) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (!shouldFocusComposerForTyping(event, document.activeElement)) return;

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
