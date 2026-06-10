/**
 * Push-to-talk (PTT) activator types and helpers.
 *
 * Electron stores the structured config in `settings.hotkeys.ptt` and sends it
 * to the native macOS helper, which matches hardware key codes and mouse
 * button numbers from a CGEvent tap. Browser/iOS surfaces still use the same
 * model with a localStorage fallback, but only focused-window DOM events are
 * observable there.
 */

export type PTTModifier =
  | "function"
  | "control"
  | "shift"
  | "option"
  | "command"
  | "rightCommand"
  | "rightOption";

export interface PTTNone {
  kind: "none";
}

export interface PTTModifierOnly {
  kind: "modifierOnly";
  modifiers: PTTModifier[];
}

export interface PTTKey {
  kind: "key";
  /** macOS virtual key code, used by the native helper. */
  keyCode: number;
  /** DOM KeyboardEvent.code, retained for display/migration/debugging. */
  code: string;
  /** Display label for the captured key (e.g. "A", "Space"). */
  label: string;
}

export interface PTTModifierKey {
  kind: "modifierKey";
  modifiers: PTTModifier[];
  keyCode: number;
  code: string;
  label: string;
}

export interface PTTMouseButton {
  kind: "mouseButton";
  /** macOS / DOM button number. Back/forward are commonly 3 and 4. */
  button: number;
}

export type PTTActivator =
  | PTTNone
  | PTTModifierOnly
  | PTTKey
  | PTTModifierKey
  | PTTMouseButton;

export const LS_PTT_ACTIVATION_KEY = "vellum:voice:activationKey";
export const NONE_PTT_ACTIVATOR: PTTNone = { kind: "none" };
export const CTRL_PTT_ACTIVATOR: PTTModifierOnly = {
  kind: "modifierOnly",
  modifiers: ["control"],
};
export const FN_PTT_ACTIVATOR: PTTModifierOnly = {
  kind: "modifierOnly",
  modifiers: ["function"],
};

interface ParseActivatorOptions {
  preserveFunction?: boolean;
}

const MODIFIER_ORDER: PTTModifier[] = [
  "function",
  "control",
  "option",
  "shift",
  "command",
  "rightOption",
  "rightCommand",
];

const MODIFIER_LABELS: Record<PTTModifier, string> = {
  function: "Fn",
  control: "Ctrl",
  option: "Alt",
  shift: "Shift",
  command: "Cmd",
  rightOption: "Right Alt",
  rightCommand: "Right Cmd",
};

const MODIFIER_ALIASES: Record<string, PTTModifier> = {
  fn: "function",
  function: "function",
  ctrl: "control",
  control: "control",
  shift: "shift",
  alt: "option",
  option: "option",
  cmd: "command",
  command: "command",
  meta: "command",
  rightcmd: "rightCommand",
  rightcommand: "rightCommand",
  rightoption: "rightOption",
  rightalt: "rightOption",
};

const MAC_KEY_CODES: Record<string, number> = {
  KeyA: 0,
  KeyS: 1,
  KeyD: 2,
  KeyF: 3,
  KeyH: 4,
  KeyG: 5,
  KeyZ: 6,
  KeyX: 7,
  KeyC: 8,
  KeyV: 9,
  KeyB: 11,
  KeyQ: 12,
  KeyW: 13,
  KeyE: 14,
  KeyR: 15,
  KeyY: 16,
  KeyT: 17,
  Digit1: 18,
  Digit2: 19,
  Digit3: 20,
  Digit4: 21,
  Digit6: 22,
  Digit5: 23,
  Equal: 24,
  Digit9: 25,
  Digit7: 26,
  Minus: 27,
  Digit8: 28,
  Digit0: 29,
  BracketRight: 30,
  KeyO: 31,
  KeyU: 32,
  BracketLeft: 33,
  KeyI: 34,
  KeyP: 35,
  Enter: 36,
  KeyL: 37,
  KeyJ: 38,
  Quote: 39,
  KeyK: 40,
  Semicolon: 41,
  Backslash: 42,
  Comma: 43,
  Slash: 44,
  KeyN: 45,
  KeyM: 46,
  Period: 47,
  Tab: 48,
  Space: 49,
  Backquote: 50,
  Backspace: 51,
  Escape: 53,
  NumpadDecimal: 65,
  NumpadMultiply: 67,
  NumpadAdd: 69,
  NumLock: 71,
  NumpadDivide: 75,
  NumpadEnter: 76,
  NumpadSubtract: 78,
  NumpadEqual: 81,
  Numpad0: 82,
  Numpad1: 83,
  Numpad2: 84,
  Numpad3: 85,
  Numpad4: 86,
  Numpad5: 87,
  Numpad6: 88,
  Numpad7: 89,
  F5: 96,
  F6: 97,
  F7: 98,
  F3: 99,
  F8: 100,
  F9: 101,
  F11: 103,
  F13: 105,
  F16: 106,
  F14: 107,
  F10: 109,
  F12: 111,
  F15: 113,
  Help: 114,
  Home: 115,
  PageUp: 116,
  Delete: 117,
  F4: 118,
  End: 119,
  F2: 120,
  PageDown: 121,
  F1: 122,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
};

const CODE_LABELS: Record<string, string> = {
  Space: "Space",
  Enter: "Return",
  Backspace: "Delete",
  Escape: "Esc",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowDown: "Down",
  ArrowUp: "Up",
};

const LABEL_CODES: Record<string, string> = {
  " ": "Space",
  Space: "Space",
  Return: "Enter",
  Enter: "Enter",
  Delete: "Backspace",
  Backspace: "Backspace",
  Esc: "Escape",
  Escape: "Escape",
  Tab: "Tab",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Down: "ArrowDown",
  Up: "ArrowUp",
};

export function sortModifiers(
  modifiers: readonly PTTModifier[],
): PTTModifier[] {
  const unique = Array.from(new Set(modifiers));
  return unique.sort(
    (a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b),
  );
}

export function modifierLabel(modifiers: readonly PTTModifier[]): string {
  return sortModifiers(modifiers)
    .map((m) => MODIFIER_LABELS[m])
    .join("+");
}

export function activatorDisplayName(activator: PTTActivator): string {
  switch (activator.kind) {
    case "none":
      return "None";
    case "modifierOnly":
      return modifierLabel(activator.modifiers);
    case "key":
      return activator.label;
    case "modifierKey": {
      const mods = modifierLabel(activator.modifiers);
      return mods ? `${mods}+${activator.label}` : activator.label;
    }
    case "mouseButton":
      return `Mouse ${activator.button}`;
  }
}

export function activatorsEqual(a: PTTActivator, b: PTTActivator): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "none":
      return true;
    case "modifierOnly":
      return sameModifierSet(a.modifiers, (b as PTTModifierOnly).modifiers);
    case "key":
      return a.keyCode === (b as PTTKey).keyCode;
    case "modifierKey":
      return (
        a.keyCode === (b as PTTModifierKey).keyCode &&
        sameModifierSet(a.modifiers, (b as PTTModifierKey).modifiers)
      );
    case "mouseButton":
      return a.button === (b as PTTMouseButton).button;
  }
}

export function serializeActivator(activator: PTTActivator): string {
  return JSON.stringify(activator);
}

export function isDisabledPttActivator(activator: PTTActivator): boolean {
  return activator.kind === "none";
}

export function isNativeOnlyPttActivator(activator: PTTActivator): boolean {
  return (
    (activator.kind === "modifierOnly" ||
      activator.kind === "modifierKey") &&
    activator.modifiers.some(
      (modifier) =>
        modifier === "function" ||
        modifier === "rightCommand" ||
        modifier === "rightOption",
    )
  );
}

export function isFnPushToTalkActivator(activator: PTTActivator): boolean {
  return (
    activator.kind === "modifierOnly" &&
    activator.modifiers.length === 1 &&
    activator.modifiers[0] === "function"
  );
}

function normalizeModifier(value: unknown): PTTModifier | null {
  if (typeof value !== "string") return null;
  return MODIFIER_ALIASES[value.replace(/[-_\s]/g, "").toLowerCase()] ?? null;
}

function normalizeModifiers(
  raw: readonly unknown[],
  options: ParseActivatorOptions,
): PTTModifier[] {
  const modifiers = raw
    .map(normalizeModifier)
    .filter((value): value is PTTModifier => value !== null);
  if (options.preserveFunction && modifiers.includes("function")) {
    return FN_PTT_ACTIVATOR.modifiers;
  }
  const filtered = options.preserveFunction
    ? modifiers
    : modifiers.filter((m) => m !== "function");
  return sortModifiers(filtered);
}

function parseKeyFields(raw: Record<string, unknown>): {
  keyCode: number;
  code: string;
  label: string;
} | null {
  const rawLabel = typeof raw.label === "string" ? raw.label : "";
  const code =
    typeof raw.code === "string"
      ? raw.code
      : rawLabel
        ? domCodeForLegacyLabel(rawLabel) ?? ""
        : "";
  const keyCode =
    typeof raw.keyCode === "number"
      ? raw.keyCode
      : typeof raw.code === "number"
        ? raw.code
        : code
          ? macKeyCodeForDomCode(code)
          : null;
  if (keyCode === null || !Number.isInteger(keyCode) || keyCode < 0) {
    return null;
  }
  const label =
    rawLabel.length > 0
      ? rawLabel
      : code
        ? labelForDomCode(code)
        : `Key ${keyCode}`;
  return { keyCode, code, label };
}

function domCodeForLegacyLabel(label: string): string | null {
  if (LABEL_CODES[label]) return LABEL_CODES[label];
  if (/^[A-Z]$/i.test(label)) return `Key${label.toUpperCase()}`;
  if (/^[0-9]$/.test(label)) return `Digit${label}`;
  return null;
}

export function parseActivator(
  raw: unknown,
  options: ParseActivatorOptions = {},
): PTTActivator {
  if (raw === null || raw === "") {
    return CTRL_PTT_ACTIVATOR;
  }
  if (typeof raw !== "string") {
    return normalizeParsedActivator(raw, options);
  }
  // Back-compat with legacy string values and pre-Electron localStorage.
  if (raw === "fn") {
    return {
      kind: "modifierOnly",
      modifiers: options.preserveFunction
        ? FN_PTT_ACTIVATOR.modifiers
        : CTRL_PTT_ACTIVATOR.modifiers,
    };
  }
  if (raw === "ctrl") {
    return CTRL_PTT_ACTIVATOR;
  }
  if (raw === "fn_shift") {
    return {
      kind: "modifierOnly",
      modifiers: options.preserveFunction
        ? FN_PTT_ACTIVATOR.modifiers
        : ["shift"],
    };
  }
  if (raw === "off" || raw === "none") {
    return NONE_PTT_ACTIVATOR;
  }
  try {
    return normalizeParsedActivator(JSON.parse(raw) as PTTActivator, options);
  } catch {
    return CTRL_PTT_ACTIVATOR;
  }
}

function normalizeParsedActivator(
  parsed: unknown,
  options: ParseActivatorOptions,
): PTTActivator {
  if (!parsed || typeof parsed !== "object") {
    return CTRL_PTT_ACTIVATOR;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.kind === "none" || obj.kind === "off") {
    return NONE_PTT_ACTIVATOR;
  }
  if (obj.kind === "modifierOnly" && Array.isArray(obj.modifiers)) {
    const modifiers = normalizeModifiers(obj.modifiers, options);
    return modifiers.length === 0
      ? CTRL_PTT_ACTIVATOR
      : { kind: "modifierOnly", modifiers };
  }
  if (obj.kind === "key") {
    const key = parseKeyFields(obj);
    if (!key) return CTRL_PTT_ACTIVATOR;
    const modifiers = Array.isArray(obj.modifiers)
      ? normalizeModifiers(obj.modifiers, options)
      : [];
    if (modifiers.length > 0) {
      return { kind: "modifierKey", modifiers, ...key };
    }
    return { kind: "key", ...key };
  }
  if (obj.kind === "modifierKey") {
    const key = parseKeyFields(obj);
    if (!key) return CTRL_PTT_ACTIVATOR;
    const rawModifiers = Array.isArray(obj.modifiers)
      ? obj.modifiers
      : obj.modifier !== undefined
        ? [obj.modifier]
        : [];
    const modifiers = normalizeModifiers(rawModifiers, options);
    return modifiers.length === 0
      ? { kind: "key", ...key }
      : { kind: "modifierKey", modifiers, ...key };
  }
  if (obj.kind === "mouseButton") {
    const button = Number(obj.button);
    if (Number.isInteger(button) && button >= 0) {
      return { kind: "mouseButton", button };
    }
  }
  return CTRL_PTT_ACTIVATOR;
}

export function macKeyCodeForDomCode(code: string): number | null {
  return MAC_KEY_CODES[code] ?? null;
}

export function labelForDomCode(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  if (code.startsWith("Numpad")) return code.replace("Numpad", "Num ");
  return code;
}

export function keyActivatorFromEvent(
  event: KeyboardEvent,
  modifiers: readonly PTTModifier[] = [],
): PTTKey | PTTModifierKey | null {
  const keyCode = macKeyCodeForDomCode(event.code);
  if (keyCode === null) return null;
  const key = {
    keyCode,
    code: event.code,
    label: labelForDomCode(event.code),
  };
  const normalizedModifiers = sortModifiers(modifiers);
  return normalizedModifiers.length > 0
    ? { kind: "modifierKey", modifiers: normalizedModifiers, ...key }
    : { kind: "key", ...key };
}

// ---------------------------------------------------------------------------
// Keyboard and mouse event matching (runtime PTT listener)
// ---------------------------------------------------------------------------

function eventModifiers(event: KeyboardEvent): PTTModifier[] {
  const mods: PTTModifier[] = [];
  if (event.ctrlKey) mods.push("control");
  if (event.altKey) mods.push("option");
  if (event.shiftKey) mods.push("shift");
  if (event.metaKey) mods.push("command");
  return mods;
}

function keyIsModifier(key: string): boolean {
  return (
    key === "Control" ||
    key === "Alt" ||
    key === "Shift" ||
    key === "Meta" ||
    key === "Fn"
  );
}

function sameModifierSet(
  a: readonly PTTModifier[],
  b: readonly PTTModifier[],
): boolean {
  const sortedA = sortModifiers(a);
  const sortedB = sortModifiers(b);
  if (sortedA.length !== sortedB.length) return false;
  return sortedA.every((m, i) => m === sortedB[i]);
}

export function eventActivatesPTT(
  event: KeyboardEvent,
  activator: PTTActivator,
): boolean {
  if (
    activator.kind === "none" ||
    activator.kind === "mouseButton" ||
    isNativeOnlyPttActivator(activator)
  ) {
    return false;
  }
  const held = eventModifiers(event);

  if (activator.kind === "modifierOnly") {
    if (!keyIsModifier(event.key)) return false;
    return sameModifierSet(held, activator.modifiers);
  }

  const eventKeyCode = macKeyCodeForDomCode(event.code);
  if (eventKeyCode !== activator.keyCode) return false;
  if (activator.kind === "key") return held.length === 0;
  return sameModifierSet(held, activator.modifiers);
}

export function eventDeactivatesPTT(
  event: KeyboardEvent,
  activator: PTTActivator,
): boolean {
  if (
    activator.kind === "none" ||
    activator.kind === "mouseButton" ||
    isNativeOnlyPttActivator(activator)
  ) {
    return false;
  }

  if (activator.kind === "modifierOnly") {
    const released = normalizeModifier(event.key);
    return released !== null && activator.modifiers.includes(released);
  }

  const eventKeyCode = macKeyCodeForDomCode(event.code);
  if (eventKeyCode === activator.keyCode) return true;
  if (activator.kind !== "modifierKey") return false;
  const released = normalizeModifier(event.key);
  return released !== null && activator.modifiers.includes(released);
}

export function mouseEventActivatesPTT(
  event: MouseEvent,
  activator: PTTActivator,
): boolean {
  return activator.kind === "mouseButton" && event.button === activator.button;
}
