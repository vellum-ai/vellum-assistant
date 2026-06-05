/**
 * Push-to-Talk (PTT) activator types and helpers.
 *
 * Mirrors the macOS `PTTActivator` model so the web port can (de)serialize
 * values already stored in `localStorage` by the settings UI. Browsers cannot
 * observe the Fn key, so stored Fn preferences fall back to Ctrl on read
 * unless the Electron host bridge asks to preserve the native Fn binding.
 */

export type PTTModifier =
  | "function"
  | "control"
  | "shift"
  | "option"
  | "command";

export interface PTTOff {
  kind: "off";
}

export interface PTTModifierOnly {
  kind: "modifierOnly";
  modifiers: PTTModifier[];
}

export interface PTTKey {
  kind: "key";
  /** Display label for the captured key (e.g. "A", "Space"). */
  label: string;
  /** Modifiers held alongside the key, if any. */
  modifiers: PTTModifier[];
}

export type PTTActivator = PTTOff | PTTModifierOnly | PTTKey;

export const LS_PTT_ACTIVATION_KEY = "vellum:voice:activationKey";
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
];

const MODIFIER_LABELS: Record<PTTModifier, string> = {
  function: "Fn",
  control: "Ctrl",
  option: "Alt",
  shift: "Shift",
  command: "Cmd",
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
  if (activator.kind === "off") {
    return "Off";
  }
  if (activator.kind === "modifierOnly") {
    return modifierLabel(activator.modifiers);
  }
  const mods = modifierLabel(activator.modifiers);
  return mods ? `${mods}+${activator.label}` : activator.label;
}

export function activatorsEqual(a: PTTActivator, b: PTTActivator): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "off" || b.kind === "off") {
    return true;
  }
  const aMods = sortModifiers(a.modifiers);
  const bMods = sortModifiers(b.modifiers);
  if (aMods.length !== bMods.length) {
    return false;
  }
  if (aMods.some((m, i) => m !== bMods[i])) {
    return false;
  }
  if (a.kind === "key" && b.kind === "key") {
    return a.label === b.label;
  }
  return true;
}

export function serializeActivator(activator: PTTActivator): string {
  return JSON.stringify(activator);
}

export function isFnPushToTalkActivator(activator: PTTActivator): boolean {
  return (
    activator.kind === "modifierOnly" &&
    activator.modifiers.length === 1 &&
    activator.modifiers[0] === "function"
  );
}

function isPTTModifier(value: unknown): value is PTTModifier {
  return (
    typeof value === "string" &&
    (MODIFIER_ORDER as readonly string[]).includes(value)
  );
}

function normalizeModifiers(
  raw: readonly unknown[],
  options: ParseActivatorOptions,
): PTTModifier[] {
  const modifiers = raw.filter(isPTTModifier);
  if (options.preserveFunction && modifiers.includes("function")) {
    return FN_PTT_ACTIVATOR.modifiers;
  }
  const filtered = options.preserveFunction
    ? modifiers
    : modifiers.filter((m) => m !== "function");
  return sortModifiers(filtered);
}

export function parseActivator(
  raw: string | null,
  options: ParseActivatorOptions = {},
): PTTActivator {
  if (!raw) {
    return CTRL_PTT_ACTIVATOR;
  }
  // Back-compat with the macOS legacy string values. Browsers cannot detect
  // the Fn key, so any stored "fn" preference falls back to Ctrl.
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
  if (raw === "off") {
    return { kind: "off" };
  }
  try {
    const parsed = JSON.parse(raw) as PTTActivator;
    if (parsed.kind === "off") {
      return { kind: "off" };
    }
    if (parsed.kind === "modifierOnly" && Array.isArray(parsed.modifiers)) {
      const modifiers = normalizeModifiers(parsed.modifiers, options);
      if (modifiers.length === 0) {
        return CTRL_PTT_ACTIVATOR;
      }
      return { kind: "modifierOnly", modifiers };
    }
    if (
      parsed.kind === "key" &&
      typeof parsed.label === "string" &&
      Array.isArray(parsed.modifiers)
    ) {
      return {
        kind: "key",
        label: parsed.label,
        modifiers: normalizeModifiers(parsed.modifiers, options),
      };
    }
  } catch {
    // fall through
  }
  return CTRL_PTT_ACTIVATOR;
}

// ---------------------------------------------------------------------------
// Keyboard event matching (runtime PTT listener)
// ---------------------------------------------------------------------------

function eventModifiers(event: KeyboardEvent): PTTModifier[] {
  const mods: PTTModifier[] = [];
  if (event.ctrlKey) {
    mods.push("control");
  }
  if (event.altKey) {
    mods.push("option");
  }
  if (event.shiftKey) {
    mods.push("shift");
  }
  if (event.metaKey) {
    mods.push("command");
  }
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
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = sortModifiers(a);
  const sortedB = sortModifiers(b);
  return sortedA.every((m, i) => m === sortedB[i]);
}

/**
 * Returns `true` if the given keyboard event fully satisfies the configured
 * activator (used to trigger start-recording on keydown).
 *
 * - For `modifierOnly` activators, returns `true` when *all* required
 *   modifiers are held and the event key is one of those modifiers (so
 *   pressing Ctrl alone fires Ctrl-only, and pressing Ctrl+Shift in sequence
 *   fires on the second keydown).
 * - For `key` activators, returns `true` when the key matches and all
 *   required modifiers are held.
 */
export function eventActivatesPTT(
  event: KeyboardEvent,
  activator: PTTActivator,
): boolean {
  if (activator.kind === "off") {
    return false;
  }
  if (activator.modifiers.includes("function")) {
    return false;
  }
  const held = eventModifiers(event);
  const requiredMods = activator.modifiers.filter((m) => m !== "function");

  if (activator.kind === "modifierOnly") {
    if (!keyIsModifier(event.key)) {
      return false;
    }
    return sameModifierSet(held, requiredMods);
  }

  const eventKeyLabel =
    event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (eventKeyLabel !== activator.label) {
    return false;
  }
  return sameModifierSet(held, requiredMods);
}

/**
 * Returns `true` if releasing this key should deactivate PTT (stop recording).
 *
 * This is called on every `keyup` while PTT is active. We stop on the first
 * key-release that would break the activator — either the non-modifier key
 * itself (for `key` activators) or *any* of the required modifiers (for
 * `modifierOnly` activators). That mirrors the "hold to talk, release to
 * submit" behaviour of a physical PTT button.
 */
export function eventDeactivatesPTT(
  event: KeyboardEvent,
  activator: PTTActivator,
): boolean {
  if (activator.kind === "off") {
    return false;
  }
  if (activator.modifiers.includes("function")) {
    return false;
  }
  const requiredMods = activator.modifiers.filter((m) => m !== "function");

  if (activator.kind === "modifierOnly") {
    if (event.key === "Control" && requiredMods.includes("control")) {
      return true;
    }
    if (event.key === "Alt" && requiredMods.includes("option")) {
      return true;
    }
    if (event.key === "Shift" && requiredMods.includes("shift")) {
      return true;
    }
    if (event.key === "Meta" && requiredMods.includes("command")) {
      return true;
    }
    return false;
  }

  const eventKeyLabel =
    event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return eventKeyLabel === activator.label;
}
