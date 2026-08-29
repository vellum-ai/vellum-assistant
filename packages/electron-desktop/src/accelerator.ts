/**
 * Validation for Electron `Accelerator` strings.
 *
 * An accelerator is a `+`-joined list of zero or more modifiers followed by a
 * single key code, matching Electron's grammar:
 * https://www.electronjs.org/docs/latest/api/accelerator
 *
 * Main validates every accelerator the renderer asks to bind before it reaches
 * `globalShortcut.register` / the application menu, so a malformed or hostile
 * value is rejected at the IPC boundary rather than thrown deep inside Electron
 * (where `globalShortcut.register` would crash the main process on some
 * inputs).
 */

import { ACCELERATOR_NAMED_KEYS } from "@vellumai/ipc-contract";

const MODIFIERS = new Set(
  [
    "Command",
    "Cmd",
    "Control",
    "Ctrl",
    "CommandOrControl",
    "CmdOrCtrl",
    "Alt",
    "Option",
    "AltGr",
    "Shift",
    "Super",
    "Meta",
  ].map((m) => m.toLowerCase()),
);

/** Matched case-insensitively; see {@link ACCELERATOR_NAMED_KEYS}. */
const NAMED_KEYS = new Set(ACCELERATOR_NAMED_KEYS.map((k) => k.toLowerCase()));

/** Single printable characters Electron accepts as a key code. */
const PUNCTUATION_KEYS = new Set([
  ")",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ":",
  ";",
  "+",
  "=",
  "<",
  ",",
  "_",
  "-",
  ">",
  ".",
  "?",
  "/",
  "~",
  "`",
  "{",
  "]",
  "|",
  "}",
  "[",
  '"',
  "'",
  "\\",
]);

const isModifier = (token: string): boolean =>
  MODIFIERS.has(token.toLowerCase());

const isKeyCode = (token: string): boolean => {
  if (token.length === 1) {
    return /[A-Za-z0-9]/.test(token) || PUNCTUATION_KEYS.has(token);
  }
  return NAMED_KEYS.has(token.toLowerCase());
};

/**
 * Split an accelerator into its `+`-separated tokens. A trailing `+` denotes a
 * literal `+` key (e.g. `"CmdOrCtrl++"`), so an empty final segment is mapped
 * back to the `"+"` token rather than being treated as a missing key.
 */
const tokenize = (accelerator: string): string[] => {
  const raw = accelerator.split("+");
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const segment = raw[i];
    if (segment === "" && i === raw.length - 1 && tokens.length > 0) {
      tokens.push("+");
    } else {
      tokens.push(segment);
    }
  }
  return tokens;
};

/**
 * True when `accelerator` is a well-formed Electron accelerator: zero or more
 * recognized modifiers followed by exactly one key code, with no empty,
 * duplicate, or unknown tokens.
 */
export const isValidAccelerator = (accelerator: string): boolean => {
  if (accelerator.length === 0) {
    return false;
  }
  const tokens = tokenize(accelerator);
  if (tokens.some((t) => t.length === 0)) {
    return false;
  }

  const key = tokens[tokens.length - 1];
  const modifiers = tokens.slice(0, -1);

  if (!isKeyCode(key)) {
    return false;
  }
  if (modifiers.some((m) => !isModifier(m))) {
    return false;
  }
  const seen = new Set(modifiers.map((m) => m.toLowerCase()));
  if (seen.size !== modifiers.length) {
    return false;
  }
  return true;
};
