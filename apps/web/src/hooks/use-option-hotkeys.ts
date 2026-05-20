
import { useEffect } from "react";

/**
 * Optional hotkeys for the paginated question card. The shared bail-out
 * (focused `<input>` / `<textarea>` and modifier-keyed combos) is enforced
 * uniformly across the digit hotkeys and these extras so callers don't need
 * to reimplement it.
 *
 *   - `onPrev`  — `ArrowLeft`  (chevron-left equivalent)
 *   - `onNext`  — `ArrowRight` (chevron-right equivalent)
 *   - `onSkip`  — letter `s` (skip the current question)
 *   - `onClose` — `Escape` (close the card)
 *
 * Each handler runs the same focused-input bail-out as the digit hotkeys,
 * so a user typing into the inline free-text input keeps arrow-key caret
 * movement, can type literal `s`, and gets the input-clear-on-Escape
 * behaviour the input owns locally — the card's pagination/skip/close
 * shortcuts only fire when no text field is focused.
 */
export interface OptionHotkeyExtras {
  onPrev?: () => void;
  onNext?: () => void;
  onSkip?: () => void;
  onClose?: () => void;
}

/**
 * Wires numeric hotkeys (1..N+1) for a question-prompt-style UI:
 *
 *   - Digits `1`..`optionCount` invoke `onSelect(digit - 1)`.
 *   - The digit equal to `optionCount + 1` invokes `onFreeText()`.
 *   - Any other digit, or a non-digit key, is ignored.
 *
 * Optional pagination/skip/close hotkeys may be supplied via `extras`; see
 * `OptionHotkeyExtras`. They share the same bail-out semantics as the digit
 * hotkeys (focused inputs and modifier-keyed combos are ignored).
 *
 * The handler **bails out** when an `<input>` or `<textarea>` is the active
 * element, so digits typed into the free-text textarea aren't intercepted —
 * the textarea owns its own keystrokes once focused. Modifier-keyed combos
 * (Cmd / Ctrl / Alt) are also ignored so we don't shadow browser shortcuts.
 *
 * The subscription is conditional on `enabled`. Flipping `enabled` to false
 * tears down the listener immediately; this lets callers disable hotkeys
 * while an option is being submitted (so a stray keypress doesn't double-fire
 * a request).
 *
 * Visible numeric badges that hint at these hotkeys should be gated on
 * `!isPointerCoarse()` — see `@/lib/pointer`. Coarse-pointer (touch) devices
 * have no practical way to press a digit without first focusing a soft
 * keyboard inside the textarea, at which point the bail-out above would
 * suppress the hotkey anyway.
 */
export function useOptionHotkeys(
  optionCount: number,
  onSelect: (index: number) => void,
  onFreeText: () => void,
  enabled: boolean,
  extras?: OptionHotkeyExtras,
): void {
  const onPrev = extras?.onPrev;
  const onNext = extras?.onNext;
  const onSkip = extras?.onSkip;
  const onClose = extras?.onClose;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      // Bail when the user is typing into a form field — otherwise digits
      // typed into the free-text textarea would be swallowed, and ArrowLeft /
      // ArrowRight would steal caret movement from the input.
      const active = document.activeElement;
      if (
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement
      ) {
        return;
      }

      // Extras: pagination / skip / close. These run before the digit
      // dispatch so the digit branch's `event.key.length !== 1` rejection
      // doesn't silently drop ArrowLeft/ArrowRight/Escape.
      if (onPrev && event.key === "ArrowLeft") {
        event.preventDefault();
        onPrev();
        return;
      }
      if (onNext && event.key === "ArrowRight") {
        event.preventDefault();
        onNext();
        return;
      }
      if (onSkip && event.key === "s") {
        event.preventDefault();
        onSkip();
        return;
      }
      if (onClose && event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      // Only single-character digit keys. `event.key` is the rendered
      // character, so this naturally rejects "Digit1" with modifiers that
      // produce e.g. "!" on US layouts.
      if (event.key.length !== 1) return;
      const digit = Number(event.key);
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return;

      if (digit <= optionCount) {
        event.preventDefault();
        onSelect(digit - 1);
        return;
      }
      if (digit === optionCount + 1) {
        event.preventDefault();
        onFreeText();
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [optionCount, onSelect, onFreeText, enabled, onPrev, onNext, onSkip, onClose]);
}
