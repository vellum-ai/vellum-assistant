import type { ResolvedHotkey } from "@/runtime/hotkeys";

/**
 * Converts a captured browser `KeyboardEvent` into an Electron
 * [`Accelerator`](https://www.electronjs.org/docs/latest/api/accelerator)
 * string, and detects binding conflicts within the catalog. The recorder in
 * the Keyboard Shortcuts settings uses these helpers; the Electron main
 * process re-validates every accelerator before binding it, so this layer is
 * about producing a sensible string and giving immediate UI feedback, not
 * about being the security boundary.
 */

/**
 * Physical-key (`KeyboardEvent.code`) → Electron key-code map for keys whose
 * `code` name differs from Electron's. Letters (`KeyA`), digits (`Digit1`),
 * and function keys (`F1`) are derived programmatically in
 * {@link mainKeyFromEvent}, so only the special cases live here. Keyed on
 * `code` (not `key`) so the result is layout- and modifier-stable — e.g.
 * Shift+`/` still resolves to the slash key rather than `?`.
 */
const CODE_TO_KEY: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Return",
  NumpadEnter: "Return",
  Space: "Space",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** Modifier keys that never stand alone as an accelerator's key code. */
const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
]);

/** Resolve the non-modifier key code from a keyboard event, or `null`. */
const mainKeyFromEvent = (event: KeyboardEvent): string | null => {
  const code = event.code;
  if (MODIFIER_CODES.has(code)) return null;

  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F[0-9]{1,2}$/.test(code)) return code;

  return CODE_TO_KEY[code] ?? null;
};

/**
 * Build an Electron accelerator from a captured keydown, or `null` when the
 * event has no bindable key (e.g. a lone modifier press while the user is
 * still composing the chord). Command maps to `CmdOrCtrl` to match the
 * compiled defaults; the physical Control key maps to `Control`.
 */
export const eventToAccelerator = (event: KeyboardEvent): string | null => {
  const key = mainKeyFromEvent(event);
  if (key === null) return null;

  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("CmdOrCtrl");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");

  return [...modifiers, key].join("+");
};

/**
 * The first command (other than `excludeKey`) already bound to `accelerator`,
 * or `null` when the accelerator is free. The catalog includes reserved,
 * non-rebindable commands (e.g. Find, Settings), so this also blocks binding
 * over an accelerator the app reserves for a fixed menu item. Disabled bindings
 * (`accelerator` resolved to `""`) never conflict. Used to block a save that
 * would shadow another shortcut.
 */
export const findConflict = (
  catalog: ResolvedHotkey[],
  excludeKey: string,
  accelerator: string,
): ResolvedHotkey | null => {
  if (accelerator === "") return null;
  return (
    catalog.find(
      (entry) => entry.key !== excludeKey && entry.accelerator === accelerator,
    ) ?? null
  );
};
