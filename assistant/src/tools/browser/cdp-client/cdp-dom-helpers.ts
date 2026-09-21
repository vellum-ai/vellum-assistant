/**
 * Common CDP idioms that each browser tool would otherwise reimplement:
 * selector resolution, mouse/keyboard dispatch, screenshot capture,
 * navigation, polling waits, and small Runtime.evaluate wrappers.
 *
 * Every helper takes a {@link CdpClient} as its first argument, forwards
 * an optional {@link AbortSignal} verbatim to `CdpClient.send`, and
 * throws a {@link CdpError} on failure. The module is pure plumbing —
 * no I/O beyond the injected CdpClient — which keeps it trivial to
 * unit-test against a fake in-memory client.
 */

import { CdpError } from "./errors.js";
import type { CdpClient } from "./types.js";

// ── Selector / node resolution ────────────────────────────────────────

/**
 * Resolve a CSS selector to a CDP `backendNodeId`. Runs
 * `DOM.getDocument` → `DOM.querySelector` → `DOM.describeNode` and
 * throws {@link CdpError} with `code: "cdp_error"` if no element
 * matches (CDP signals this by returning `nodeId: 0`).
 */
export async function querySelectorBackendNodeId(
  cdp: CdpClient,
  selector: string,
  signal?: AbortSignal,
): Promise<number> {
  const { root } = await cdp.send<{ root: { nodeId: number } }>(
    "DOM.getDocument",
    {},
    signal,
  );
  const { nodeId } = await cdp.send<{ nodeId: number }>(
    "DOM.querySelector",
    { nodeId: root.nodeId, selector },
    signal,
  );
  if (!nodeId) {
    throw new CdpError("cdp_error", `Element not found: ${selector}`, {
      cdpMethod: "DOM.querySelector",
      cdpParams: { selector },
    });
  }
  const { node } = await cdp.send<{ node: { backendNodeId: number } }>(
    "DOM.describeNode",
    { nodeId, depth: 0 },
    signal,
  );
  return node.backendNodeId;
}

/** Scroll the element identified by `backendNodeId` into view if needed. */
export async function scrollIntoViewIfNeeded(
  cdp: CdpClient,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<void> {
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, signal);
}

/**
 * Read the element's content-quad via `DOM.getBoxModel` and return the
 * midpoint in viewport coordinates. CDP returns `content` as a flat
 * 8-number array `[x1,y1, x2,y2, x3,y3, x4,y4]`.
 */
export async function getCenterPoint(
  cdp: CdpClient,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<{ x: number; y: number }> {
  const { model } = await cdp.send<{
    model: { content: number[] };
  }>("DOM.getBoxModel", { backendNodeId }, signal);
  const xs = [
    model.content[0]!,
    model.content[2]!,
    model.content[4]!,
    model.content[6]!,
  ];
  const ys = [
    model.content[1]!,
    model.content[3]!,
    model.content[5]!,
    model.content[7]!,
  ];
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

/** Focus an element by `backendNodeId` via `DOM.focus`. */
export async function focusElement(
  cdp: CdpClient,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<void> {
  await cdp.send("DOM.focus", { backendNodeId }, signal);
}

// ── Mouse / keyboard / wheel dispatch ─────────────────────────────────

/**
 * Dispatch a full left-click (mouseMoved + mousePressed + mouseReleased)
 * at the given viewport point.
 */
export async function dispatchClickAt(
  cdp: CdpClient,
  point: { x: number; y: number },
  signal?: AbortSignal,
): Promise<void> {
  const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
  await cdp.send(
    "Input.dispatchMouseEvent",
    { ...base, type: "mouseMoved" },
    signal,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { ...base, type: "mousePressed" },
    signal,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { ...base, type: "mouseReleased" },
    signal,
  );
}

/** Dispatch a single mouseMoved (hover) at the given viewport point. */
export async function dispatchHoverAt(
  cdp: CdpClient,
  point: { x: number; y: number },
  signal?: AbortSignal,
): Promise<void> {
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: point.x, y: point.y, button: "none" },
    signal,
  );
}

/**
 * Insert text at the currently focused element via `Input.insertText`.
 * Unlike synthesizing individual key events, this dispatches the right
 * `input`/`change` events that form controls expect.
 */
export async function dispatchInsertText(
  cdp: CdpClient,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  await cdp.send("Input.insertText", { text }, signal);
}

interface TextInsertionOptions {
  clearFirst: boolean;
  verify?: boolean;
}

/**
 * Select editable content, insert text through CDP, and confirm that the live
 * target contains the requested text. Controls without text-selection support
 * are cleared through their native value setter and an input event.
 */
export async function insertTextIntoElement(
  cdp: CdpClient,
  backendNodeId: number,
  text: string,
  options: TextInsertionOptions,
  signal?: AbortSignal,
): Promise<void> {
  await focusElement(cdp, backendNodeId, signal);

  const { object } = await cdp.send<{ object: { objectId: string } }>(
    "DOM.resolveNode",
    { backendNodeId },
    signal,
  );
  const selection = await cdp.send<{
    result?: {
      value?: { initialLength?: number; needsRefocus?: boolean };
    };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>(
    "Runtime.callFunctionOn",
    {
      objectId: object.objectId,
      functionDeclaration: `function(clearFirst) {
        if (typeof this.value === "string") {
          const value = this.value;
          if (clearFirst && typeof this.select === "function") {
            try {
              this.select();
              if (this.selectionStart === 0 && this.selectionEnd === value.length) {
                return { needsRefocus: false };
              }
            } catch {}

            const view = this.ownerDocument?.defaultView;
            const constructor = this.tagName === "INPUT"
              ? view?.HTMLInputElement
              : this.tagName === "TEXTAREA"
                ? view?.HTMLTextAreaElement
                : undefined;
            const valueSetter = constructor
              ? Object.getOwnPropertyDescriptor(constructor.prototype, "value")?.set
              : undefined;
            if (!valueSetter || !view?.InputEvent) {
              throw new Error("Element does not support replacing its text");
            }
            valueSetter.call(this, "");
            this.dispatchEvent(new view.InputEvent("input", {
              bubbles: true,
              inputType: "deleteContentBackward",
              data: null,
            }));
            return { needsRefocus: true };
          }
          if (typeof this.setSelectionRange === "function") {
            const end = this.value.length;
            try {
              this.setSelectionRange(clearFirst ? 0 : end, end);
            } catch (error) {
              if (clearFirst) {
                throw error;
              }
            }
            return clearFirst
              ? { needsRefocus: false }
              : { initialLength: value.length, needsRefocus: false };
          }
        }
        if (this.isContentEditable) {
          const value = this.textContent ?? "";
          const selection = this.ownerDocument.getSelection();
          const range = this.ownerDocument.createRange();
          range.selectNodeContents(this);
          if (!clearFirst) {
            range.collapse(false);
          }
          selection.removeAllRanges();
          selection.addRange(range);
          return clearFirst
            ? { needsRefocus: false }
            : { initialLength: value.length, needsRefocus: false };
        }
        throw new Error("Element is not an editable text target");
      }`,
      arguments: [{ value: options.clearFirst }],
      returnByValue: true,
    },
    signal,
  );
  if (selection.exceptionDetails) {
    const message =
      selection.exceptionDetails.exception?.description ??
      selection.exceptionDetails.text ??
      "Unable to select editable text";
    throw new CdpError("cdp_error", message, {
      cdpMethod: "Runtime.callFunctionOn",
      cdpParams: { backendNodeId },
    });
  }

  if (selection.result?.value?.needsRefocus === true) {
    await focusElement(cdp, backendNodeId, signal);
  }
  await dispatchInsertText(cdp, text, signal);
  if (options.verify === false) {
    return;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const verification = await cdp.send<{
      result?: { value?: { connected?: boolean; matches?: boolean } };
    }>(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function(insertedText, clearFirst, initialLength) {
          const text = typeof this.value === "string"
            ? this.value
            : (this.textContent ?? "");
          const normalizedInsertedText = this.tagName === "TEXTAREA"
            ? insertedText.replace(/\\r\\n?/g, "\\n")
            : insertedText;
          const matches = clearFirst
            ? text === normalizedInsertedText
            : Number.isInteger(initialLength)
              && text.length === initialLength + normalizedInsertedText.length
              && text.endsWith(normalizedInsertedText);
          return { connected: this.isConnected, matches };
        }`,
        arguments: [
          { value: text },
          { value: options.clearFirst },
          { value: selection.result?.value?.initialLength ?? null },
        ],
        returnByValue: true,
      },
      signal,
    );
    const result = verification.result?.value;
    if (result?.connected === true && result.matches === true) {
      return;
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new CdpError(
    "cdp_error",
    "Text insertion did not persist in the editable element.",
    {
      cdpMethod: "Input.insertText",
      cdpParams: { backendNodeId },
    },
  );
}

/**
 * Per-key descriptor used by {@link dispatchKeyPress}. Mirrors the
 * fields CDP's `Input.dispatchKeyEvent` accepts. `text` is set only
 * for printable keys (so we know to also dispatch a `char` event).
 */
interface KeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

interface ModifierDescriptor {
  bit: number;
  descriptor: KeyDescriptor;
}

const ALT_MODIFIER: ModifierDescriptor = {
  bit: 1,
  descriptor: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
};
const CONTROL_MODIFIER: ModifierDescriptor = {
  bit: 2,
  descriptor: {
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
  },
};
const META_MODIFIER: ModifierDescriptor = {
  bit: 4,
  descriptor: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
};
const SHIFT_MODIFIER: ModifierDescriptor = {
  bit: 8,
  descriptor: {
    key: "Shift",
    code: "ShiftLeft",
    windowsVirtualKeyCode: 16,
  },
};

const MODIFIER_DESCRIPTORS: Record<string, ModifierDescriptor> = {
  alt: ALT_MODIFIER,
  option: ALT_MODIFIER,
  control: CONTROL_MODIFIER,
  ctrl: CONTROL_MODIFIER,
  meta: META_MODIFIER,
  command: META_MODIFIER,
  cmd: META_MODIFIER,
  shift: SHIFT_MODIFIER,
};

const PUNCTUATION_KEYS = [
  {
    unshifted: "`",
    shifted: "~",
    code: "Backquote",
    windowsVirtualKeyCode: 192,
  },
  {
    unshifted: "-",
    shifted: "_",
    code: "Minus",
    windowsVirtualKeyCode: 189,
  },
  {
    unshifted: "=",
    shifted: "+",
    code: "Equal",
    windowsVirtualKeyCode: 187,
  },
  {
    unshifted: "[",
    shifted: "{",
    code: "BracketLeft",
    windowsVirtualKeyCode: 219,
  },
  {
    unshifted: "]",
    shifted: "}",
    code: "BracketRight",
    windowsVirtualKeyCode: 221,
  },
  {
    unshifted: "\\",
    shifted: "|",
    code: "Backslash",
    windowsVirtualKeyCode: 220,
  },
  {
    unshifted: ";",
    shifted: ":",
    code: "Semicolon",
    windowsVirtualKeyCode: 186,
  },
  {
    unshifted: "'",
    shifted: '"',
    code: "Quote",
    windowsVirtualKeyCode: 222,
  },
  {
    unshifted: ",",
    shifted: "<",
    code: "Comma",
    windowsVirtualKeyCode: 188,
  },
  {
    unshifted: ".",
    shifted: ">",
    code: "Period",
    windowsVirtualKeyCode: 190,
  },
  {
    unshifted: "/",
    shifted: "?",
    code: "Slash",
    windowsVirtualKeyCode: 191,
  },
] as const;

/**
 * Subset of the US keyboard layout used to populate
 * `Input.dispatchKeyEvent` params. Without these fields, sites that
 * read `event.keyCode` (e.g. `event.keyCode === 13` for Enter) or
 * `event.code` see zeros and the press is silently ignored.
 *
 * Single-character keys (a-z, A-Z, 0-9) are resolved dynamically by
 * {@link resolveKeyDescriptor} to keep the static map small.
 */
const KEY_DESCRIPTORS: Record<string, KeyDescriptor> = {
  Enter: {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: {
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Insert: { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: {
    key: "ArrowDown",
    code: "ArrowDown",
    windowsVirtualKeyCode: 40,
  },
  ArrowLeft: {
    key: "ArrowLeft",
    code: "ArrowLeft",
    windowsVirtualKeyCode: 37,
  },
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  },
  // Navigation keys. Sites commonly check `event.keyCode` for these
  // (PageDown = 34 to scroll a page, Home = 36 to jump to top, etc.)
  // so omitting `code`/`windowsVirtualKeyCode` makes the press a
  // silent no-op on those handlers.
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  // Space is special: Playwright callers use "Space" as the key name
  // but `event.key` is actually " ". Accept both spellings so either
  // calling convention works, and always emit `code: "Space"` +
  // `windowsVirtualKeyCode: 32` so Space-to-activate / Space-to-scroll
  // handlers fire correctly.
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  // Function keys (F1-F12). Virtual key codes 112-123 per the Windows
  // input API. `resolveKeyDescriptor` cannot derive these dynamically
  // because they are multi-character names with no 1:1 char mapping.
  F1: { key: "F1", code: "F1", windowsVirtualKeyCode: 112 },
  F2: { key: "F2", code: "F2", windowsVirtualKeyCode: 113 },
  F3: { key: "F3", code: "F3", windowsVirtualKeyCode: 114 },
  F4: { key: "F4", code: "F4", windowsVirtualKeyCode: 115 },
  F5: { key: "F5", code: "F5", windowsVirtualKeyCode: 116 },
  F6: { key: "F6", code: "F6", windowsVirtualKeyCode: 117 },
  F7: { key: "F7", code: "F7", windowsVirtualKeyCode: 118 },
  F8: { key: "F8", code: "F8", windowsVirtualKeyCode: 119 },
  F9: { key: "F9", code: "F9", windowsVirtualKeyCode: 120 },
  F10: { key: "F10", code: "F10", windowsVirtualKeyCode: 121 },
  F11: { key: "F11", code: "F11", windowsVirtualKeyCode: 122 },
  F12: { key: "F12", code: "F12", windowsVirtualKeyCode: 123 },
};

/**
 * Resolve a key name into a {@link KeyDescriptor}. Single-character
 * keys (a-z, A-Z, 0-9) are computed on demand: `code` is `KeyA`/
 * `Digit0`/etc., `windowsVirtualKeyCode` is the uppercase ASCII code,
 * and `text` is the literal character. Returns `null` for unknown
 * multi-character keys so callers can fall back to a minimal event.
 */
function resolveKeyDescriptor(key: string): KeyDescriptor | null {
  const fromMap = KEY_DESCRIPTORS[key];
  if (fromMap) {
    return fromMap;
  }
  const punctuation = PUNCTUATION_KEYS.find(
    ({ unshifted, shifted }) => key === unshifted || key === shifted,
  );
  if (punctuation) {
    return {
      key,
      code: punctuation.code,
      windowsVirtualKeyCode: punctuation.windowsVirtualKeyCode,
      text: key,
    };
  }
  if (key.length !== 1) {
    return null;
  }
  const charCode = key.charCodeAt(0);
  // a-z / A-Z
  if (
    (charCode >= 65 && charCode <= 90) ||
    (charCode >= 97 && charCode <= 122)
  ) {
    const upper = key.toUpperCase();
    return {
      key,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: key,
    };
  }
  // 0-9
  if (charCode >= 48 && charCode <= 57) {
    return {
      key,
      code: `Digit${key}`,
      windowsVirtualKeyCode: charCode,
      text: key,
    };
  }
  // Other printable ASCII (space, punctuation): still emit text + the
  // raw char code so sites that check `event.key` and `event.charCode`
  // see something sensible.
  if (charCode >= 32 && charCode <= 126) {
    return {
      key,
      code: "",
      windowsVirtualKeyCode: charCode,
      text: key,
    };
  }
  return null;
}

function describeKeyEvent(
  descriptor: KeyDescriptor,
  type: "rawKeyDown" | "char" | "keyUp",
  modifiers: number,
  unmodifiedText = descriptor.text,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    type,
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
  };
  if (modifiers !== 0) {
    params.modifiers = modifiers;
  }
  if (type === "char" && descriptor.text !== undefined) {
    params.text = descriptor.text;
    params.unmodifiedText = unmodifiedText;
  }
  return params;
}

const SHIFTED_CHARACTERS: Record<string, string> = {
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  ...Object.fromEntries(
    PUNCTUATION_KEYS.map(({ unshifted, shifted }) => [unshifted, shifted]),
  ),
};

function applyShift(descriptor: KeyDescriptor): KeyDescriptor {
  if (descriptor.text === undefined) {
    return descriptor;
  }
  const shifted =
    descriptor.text >= "a" && descriptor.text <= "z"
      ? descriptor.text.toUpperCase()
      : (SHIFTED_CHARACTERS[descriptor.text] ?? descriptor.text);
  return { ...descriptor, key: shifted, text: shifted };
}

/**
 * Press a key or modifier chord using the same `Modifier+Key` spelling as
 * Playwright. Printable keys use rawKeyDown + char + keyUp, with text only on
 * the char event, so the browser inserts exactly one character.
 */
export async function dispatchKeyPress(
  cdp: CdpClient,
  key: string,
  signal?: AbortSignal,
): Promise<void> {
  const parts = key === "+" ? [key] : key.split("+");
  const primaryKey = parts.at(-1) ?? "";
  const modifierTokens = parts.slice(0, -1);
  const modifiers: ModifierDescriptor[] = [];
  let modifierBits = 0;

  for (const token of modifierTokens) {
    const modifier = MODIFIER_DESCRIPTORS[token.toLowerCase()];
    if (!modifier || (modifierBits & modifier.bit) !== 0) {
      throw new CdpError("cdp_error", `Unsupported key chord: ${key}`);
    }
    modifierBits |= modifier.bit;
    modifiers.push(modifier);
  }

  const standaloneModifier = MODIFIER_DESCRIPTORS[primaryKey.toLowerCase()];
  if (standaloneModifier && (modifierBits & standaloneModifier.bit) !== 0) {
    throw new CdpError("cdp_error", `Unsupported key chord: ${key}`);
  }
  const unmodifiedDescriptor =
    standaloneModifier?.descriptor ?? resolveKeyDescriptor(primaryKey);
  if (!unmodifiedDescriptor) {
    throw new CdpError("cdp_error", `Unsupported key: ${primaryKey || key}`);
  }
  const descriptor =
    (modifierBits & SHIFT_MODIFIER.bit) !== 0
      ? applyShift(unmodifiedDescriptor)
      : unmodifiedDescriptor;
  const primaryDownModifiers = modifierBits | (standaloneModifier?.bit ?? 0);

  let activeModifiers = 0;
  const pressedModifiers: ModifierDescriptor[] = [];
  let primaryPressed = false;
  try {
    for (const modifier of modifiers) {
      const nextModifiers = activeModifiers | modifier.bit;
      activeModifiers = nextModifiers;
      pressedModifiers.push(modifier);
      await cdp.send(
        "Input.dispatchKeyEvent",
        describeKeyEvent(modifier.descriptor, "rawKeyDown", nextModifiers),
        signal,
      );
    }

    const suppressText = (modifierBits & (1 | 2 | 4)) !== 0;
    primaryPressed = true;
    await cdp.send(
      "Input.dispatchKeyEvent",
      describeKeyEvent(descriptor, "rawKeyDown", primaryDownModifiers),
      signal,
    );
    if (descriptor.text !== undefined && !suppressText) {
      await cdp.send(
        "Input.dispatchKeyEvent",
        describeKeyEvent(
          descriptor,
          "char",
          modifierBits,
          unmodifiedDescriptor.text,
        ),
        signal,
      );
    }
    await cdp.send(
      "Input.dispatchKeyEvent",
      describeKeyEvent(descriptor, "keyUp", modifierBits),
      signal,
    );
    primaryPressed = false;

    while (pressedModifiers.length > 0) {
      const modifier = pressedModifiers.at(-1)!;
      const nextModifiers = activeModifiers & ~modifier.bit;
      await cdp.send(
        "Input.dispatchKeyEvent",
        describeKeyEvent(modifier.descriptor, "keyUp", nextModifiers),
        signal,
      );
      activeModifiers = nextModifiers;
      pressedModifiers.pop();
    }
  } finally {
    if (primaryPressed) {
      try {
        await cdp.send(
          "Input.dispatchKeyEvent",
          describeKeyEvent(descriptor, "keyUp", activeModifiers),
        );
      } catch {}
    }

    while (pressedModifiers.length > 0) {
      const modifier = pressedModifiers.pop()!;
      activeModifiers &= ~modifier.bit;
      try {
        await cdp.send(
          "Input.dispatchKeyEvent",
          describeKeyEvent(modifier.descriptor, "keyUp", activeModifiers),
        );
      } catch {}
    }
  }
}

/** Dispatch a wheel scroll delta at the given viewport point. */
export async function dispatchWheelScroll(
  cdp: CdpClient,
  point: { x: number; y: number },
  delta: { deltaX: number; deltaY: number },
  signal?: AbortSignal,
): Promise<void> {
  await cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: delta.deltaX,
      deltaY: delta.deltaY,
    },
    signal,
  );
}

// ── Runtime.evaluate wrappers ─────────────────────────────────────────

/** Get the current page URL via `Runtime.evaluate("document.location.href")`. */
export async function getCurrentUrl(
  cdp: CdpClient,
  signal?: AbortSignal,
): Promise<string> {
  const { result } = await cdp.send<{ result: { value: string } }>(
    "Runtime.evaluate",
    { expression: "document.location.href", returnByValue: true },
    signal,
  );
  return result.value;
}

/** Get the current page title via `Runtime.evaluate("document.title")`. */
export async function getPageTitle(
  cdp: CdpClient,
  signal?: AbortSignal,
): Promise<string> {
  const { result } = await cdp.send<{ result: { value: string } }>(
    "Runtime.evaluate",
    { expression: "document.title", returnByValue: true },
    signal,
  );
  return result.value ?? "";
}

/**
 * Evaluate a JS expression via `Runtime.evaluate` and return the
 * deserialized value. Throws {@link CdpError} with `code: "cdp_error"`
 * if the expression threw (surfaced via CDP's `exceptionDetails`).
 *
 * Defaults: `returnByValue: true`, `awaitPromise: true`, `userGesture: true`.
 */
export async function evaluateExpression<T = unknown>(
  cdp: CdpClient,
  expression: string,
  opts?: { awaitPromise?: boolean },
  signal?: AbortSignal,
): Promise<T> {
  const res = await cdp.send<{
    result: { value: T };
    exceptionDetails?: {
      text?: string;
      exception?: { description?: string };
    };
  }>(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: opts?.awaitPromise ?? true,
      userGesture: true,
    },
    signal,
  );
  if (res.exceptionDetails) {
    const msg =
      res.exceptionDetails.exception?.description ??
      res.exceptionDetails.text ??
      "Runtime.evaluate exception";
    throw new CdpError("cdp_error", msg, {
      cdpMethod: "Runtime.evaluate",
      cdpParams: { expression },
    });
  }
  return res.result.value;
}

// ── Screenshot ────────────────────────────────────────────────────────

/**
 * Capture a JPEG screenshot via `Page.captureScreenshot` and return the
 * decoded bytes as a Node `Buffer`. Defaults to quality 80. Pass
 * `fullPage: true` to capture beyond the viewport.
 */
export async function captureScreenshotJpeg(
  cdp: CdpClient,
  opts: { quality?: number; fullPage?: boolean } = {},
  signal?: AbortSignal,
): Promise<Buffer> {
  const { data } = await cdp.send<{ data: string }>(
    "Page.captureScreenshot",
    {
      format: "jpeg",
      quality: opts.quality ?? 80,
      captureBeyondViewport: opts.fullPage === true,
    },
    signal,
  );
  return Buffer.from(data, "base64");
}

// ── Navigation / waiting ──────────────────────────────────────────────

/**
 * Navigate to `url` and wait until the new document has committed
 * (the URL has changed from the pre-navigation URL, or it's a
 * same-URL reload) AND `document.readyState` has reached
 * `interactive` or `complete`, or the timeout elapses.
 *
 * CDP's `Page.navigate` resolves as soon as the request is sent, not
 * when the page has loaded. Subscribing to lifecycle events would
 * require a long-lived event channel that the extension-backed
 * CdpClient cannot currently provide, so this helper polls both
 * `document.readyState` and `document.location.href` via
 * {@link evaluateExpression} — which works uniformly across both
 * Playwright-backed and extension-backed clients.
 *
 * The commit-detection step is the interesting part: on same-origin
 * navigations or cached responses, the browser can return
 * `readyState === "complete"` from the OLD execution context for a
 * brief window after `Page.navigate` resolves but before the new
 * document has been installed. Reading only `readyState` would
 * accept that stale state and report success against the old URL.
 * Combining the two observations in a single evaluate and requiring
 * an observed URL change closes that race.
 *
 * Returns `{ finalUrl, timedOut }`. `finalUrl` is the last `href`
 * observed inside the polling loop (so it reflects the new document
 * even on commit races) and may differ from `url` if the page
 * redirected.
 */
export async function navigateAndWait(
  cdp: CdpClient,
  url: string,
  opts: { timeoutMs?: number } = {},
  signal?: AbortSignal,
): Promise<{ finalUrl: string; timedOut: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;

  // Capture the pre-navigation URL so the polling loop can detect
  // when the new document has committed. If the pre-read fails (rare
  // — e.g. a fresh about:blank that hasn't initialized a Runtime
  // context yet), we fall back to readyState-only polling because we
  // have no baseline to compare against.
  let urlBeforeNav = "";
  try {
    urlBeforeNav = await getCurrentUrl(cdp, signal);
  } catch {
    // Non-fatal: urlBeforeNav stays empty and commit detection becomes
    // a no-op (see `committed` below).
  }

  // CDP's `Page.navigate` does NOT throw on transport-layer errors
  // (DNS failure, connection refused, etc.). Instead it resolves with
  // `{ frameId, errorText? }` and we have to surface the failure
  // ourselves. Otherwise we silently start polling readyState on the
  // OLD page (which is "complete") and report success with the stale
  // URL.
  const navResp = await cdp.send<{ frameId?: string; errorText?: string }>(
    "Page.navigate",
    { url },
    signal,
  );
  if (navResp?.errorText) {
    throw new CdpError("cdp_error", navResp.errorText, {
      cdpMethod: "Page.navigate",
      cdpParams: { url },
    });
  }

  // Same-URL reloads (including `about:blank` → `about:blank`) can't
  // be detected via URL change. Fall back to readyState-only polling
  // in that case, matching the pre-commit-detection behavior.
  const sameUrlReload = urlBeforeNav !== "" && url === urlBeforeNav;

  const startedAt = Date.now();
  // Track exit reason explicitly so the post-loop classification does
  // not race against `Date.now()` (the final read could otherwise
  // push us across the timeout boundary and falsely flip `timedOut`
  // back to true).
  let completed = false;
  // Track the last href we successfully observed from inside the
  // loop. We prefer this to a post-loop `getCurrentUrl` call because
  // the latter races the very same commit window that motivates the
  // in-loop commit check.
  let lastKnownHref = urlBeforeNav;

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw new CdpError("aborted", "Navigation aborted");
    }

    // Query `readyState` and `location.href` in a single evaluate so
    // the two observations come from the same execution context and
    // cannot straddle a commit boundary.
    try {
      const snapshot = await evaluateExpression<{
        readyState: string;
        href: string;
      }>(
        cdp,
        "({ readyState: document.readyState, href: document.location.href })",
        {},
        signal,
      );
      if (snapshot && typeof snapshot.href === "string") {
        lastKnownHref = snapshot.href;
      }
      const readyStateOk =
        snapshot?.readyState === "interactive" ||
        snapshot?.readyState === "complete";
      // On cross-URL navigations, require BOTH a ready readyState
      // AND an observed URL change so we don't accept the OLD
      // page's "complete" state before the new document has
      // committed. Same-URL reloads and missing pre-nav URLs fall
      // back to readyState-only because there's nothing to compare.
      const committed =
        sameUrlReload ||
        urlBeforeNav === "" ||
        (typeof snapshot?.href === "string" && snapshot.href !== urlBeforeNav);
      if (readyStateOk && committed) {
        completed = true;
        break;
      }
    } catch (err) {
      // `Runtime.evaluate` can fail transiently while the old
      // execution context is being torn down and the new one has
      // not yet been created ("Execution context was destroyed" /
      // "Cannot find context with specified id"). Treat CDP errors
      // as retry-worthy; the timeout bound below guarantees we
      // don't loop forever. Abort errors are re-thrown so the
      // caller's AbortSignal is still honoured promptly.
      if (err instanceof CdpError && err.code === "aborted") {
        throw err;
      }
      if (!(err instanceof CdpError)) {
        throw err;
      }
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  const timedOut = !completed;

  // Prefer the last href observed inside the loop. If the loop never
  // produced a successful observation (e.g. all evaluates failed to
  // transient context errors), fall back to `getCurrentUrl` as a
  // best-effort read.
  let finalUrl = lastKnownHref;
  if (finalUrl === "") {
    try {
      finalUrl = await getCurrentUrl(cdp, signal);
    } catch {
      // Nothing more to do — surface empty string and let the caller
      // decide how to render it.
    }
  }
  return { finalUrl, timedOut };
}

/**
 * Poll until a selector matches an element in the requested state,
 * then return its `backendNodeId`. Throws {@link CdpError} on timeout
 * or abort.
 *
 * `state` controls the readiness check:
 * - `"visible"` (default): the element must be in the DOM AND have a
 *   non-zero bounding box AND not be `display:none` /
 *   `visibility:hidden`. This matches Playwright's
 *   `page.waitForSelector` default and is the right semantics for
 *   click/hover targets that may be hydrated asynchronously.
 * - `"attached"`: the element only needs to exist in the DOM. Useful
 *   for `browser_wait_for` selector mode where the caller just wants
 *   to know "did this node appear at all" regardless of layout.
 */
export async function waitForSelector(
  cdp: CdpClient,
  selector: string,
  timeoutMs: number,
  signal?: AbortSignal,
  opts: { state?: "attached" | "visible" } = {},
): Promise<number> {
  const state = opts.state ?? "visible";
  const startedAt = Date.now();
  const escapedSel = JSON.stringify(selector);
  const expression =
    state === "visible"
      ? `(() => {
          const el = document.querySelector(${escapedSel});
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
        })()`
      : `document.querySelector(${escapedSel}) !== null`;
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw new CdpError("aborted", "waitForSelector aborted");
    }
    const ready = await evaluateExpression<boolean>(
      cdp,
      expression,
      {},
      signal,
    );
    if (ready) {
      return await querySelectorBackendNodeId(cdp, selector, signal);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new CdpError("cdp_error", `Timed out waiting for ${selector}`);
}

/**
 * Poll `document.body.innerText` for a substring. Throws
 * {@link CdpError} on timeout or abort.
 */
export async function waitForText(
  cdp: CdpClient,
  text: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const escaped = JSON.stringify(text);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw new CdpError("aborted", "waitForText aborted");
    }
    const found = await evaluateExpression<boolean>(
      cdp,
      `(document.body?.innerText ?? "").includes(${escaped})`,
      {},
      signal,
    );
    if (found) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new CdpError("cdp_error", `Timed out waiting for text: ${text}`);
}
