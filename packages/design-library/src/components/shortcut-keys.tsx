import { type ComponentProps } from "react";

import { cn } from "../utils/cn";

/**
 * Renders an Electron [`Accelerator`](https://www.electronjs.org/docs/latest/api/accelerator)
 * string as a row of key caps (e.g. `"CmdOrCtrl+Shift+N"` renders ⌘ ⇧ N on
 * macOS and Ctrl Shift N on Windows). Presentation-only: it does not capture
 * or validate input, so it is reusable anywhere a binding needs to be shown
 * (Keyboard Shortcuts settings, the command palette, menu hints).
 *
 * Modifier and named-key tokens are mapped per platform; an empty accelerator
 * renders nothing, which callers use to show a "disabled" binding.
 */

/** Which key-cap vocabulary to render: macOS glyphs or Windows text labels. */
export type ShortcutPlatform = "mac" | "windows";

/**
 * Detect the shortcut vocabulary for the current host from `navigator`. Apple
 * hosts (and unknown hosts, e.g. SSR or test DOMs) get glyphs; Windows and
 * Linux get text labels. Electron renderers report the host OS here too, so
 * this is correct inside the desktop apps.
 */
export const detectShortcutPlatform = (): ShortcutPlatform => {
  if (typeof navigator === "undefined") {
    return "mac";
  }
  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  const platform = (uaData?.platform || navigator.platform || "").toLowerCase();
  // "darwin" contains "win", so rule out Apple hosts first.
  if (/mac|darwin|iphone|ipad|ipod/.test(platform)) {
    return "mac";
  }
  return /win|linux/.test(platform) ? "windows" : "mac";
};

const MAC_MODIFIER_SYMBOLS: Record<string, string> = {
  command: "\u2318",
  cmd: "\u2318",
  commandorcontrol: "\u2318",
  cmdorctrl: "\u2318",
  super: "\u2318",
  meta: "\u2318",
  control: "\u2303",
  ctrl: "\u2303",
  alt: "\u2325",
  option: "\u2325",
  altgr: "\u2325",
  shift: "\u21e7",
};

const WINDOWS_MODIFIER_LABELS: Record<string, string> = {
  command: "Win",
  cmd: "Win",
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
  super: "Win",
  meta: "Win",
  control: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  altgr: "AltGr",
  shift: "Shift",
};

const MAC_KEY_SYMBOLS: Record<string, string> = {
  up: "\u2191",
  down: "\u2193",
  left: "\u2190",
  right: "\u2192",
  return: "\u21a9",
  enter: "\u21a9",
  space: "\u2423",
  backspace: "\u232b",
  delete: "\u2326",
  escape: "\u238b",
  esc: "\u238b",
  tab: "\u21e5",
  pageup: "\u21de",
  pagedown: "\u21df",
  home: "\u2196",
  end: "\u2198",
  plus: "+",
};

const WINDOWS_KEY_LABELS: Record<string, string> = {
  up: "\u2191",
  down: "\u2193",
  left: "\u2190",
  right: "\u2192",
  return: "Enter",
  enter: "Enter",
  space: "Space",
  backspace: "Backspace",
  delete: "Del",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  plus: "+",
};

const TOKEN_MAPS: Record<
  ShortcutPlatform,
  { modifiers: Record<string, string>; keys: Record<string, string> }
> = {
  mac: { modifiers: MAC_MODIFIER_SYMBOLS, keys: MAC_KEY_SYMBOLS },
  windows: { modifiers: WINDOWS_MODIFIER_LABELS, keys: WINDOWS_KEY_LABELS },
};

/**
 * Split an accelerator into its `+`-joined tokens, preserving a trailing `+`
 * as the literal plus key. Mirrors the tokenizer the Electron main process
 * validates against.
 */
const tokenize = (accelerator: string): string[] => {
  const raw = accelerator.split("+");
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const segment = raw[i];
    if (segment === "" && i === raw.length - 1 && tokens.length > 0) {
      tokens.push("+");
    } else if (segment !== "") {
      tokens.push(segment);
    }
  }
  return tokens;
};

/** Convert one accelerator token to its display label for a platform. */
const displayToken = (token: string, platform: ShortcutPlatform): string => {
  const lower = token.toLowerCase();
  const { modifiers, keys } = TOKEN_MAPS[platform];
  return modifiers[lower] ?? keys[lower] ?? token.toUpperCase();
};

type ModifierId = "control" | "alt" | "shift" | "command";

/**
 * Which modifier a token names, independent of the spelling the accelerator
 * used. `"platform"` is the `CmdOrCtrl` family, which is a different modifier
 * on each host and so cannot be ranked until the platform is known.
 */
const MODIFIER_IDS: Record<string, ModifierId | "platform"> = {
  command: "command",
  cmd: "command",
  super: "command",
  meta: "command",
  commandorcontrol: "platform",
  cmdorctrl: "platform",
  control: "control",
  ctrl: "control",
  alt: "alt",
  option: "alt",
  altgr: "alt",
  shift: "shift",
};

/**
 * The order each platform writes its modifiers in, which is a convention of
 * the platform rather than of the accelerator that happened to be typed.
 *
 * macOS is fixed at Control, Option, Shift, Command by the
 * [Apple Style Guide](https://support.apple.com/guide/applestyleguide/welcome/web),
 * so `⇧⌘N` is correct and `⌘⇧N` is not, and Windows leads with the Windows
 * key then Ctrl, Alt, Shift per
 * [Microsoft's keyboard UX guidance](https://learn.microsoft.com/en-us/windows/win32/uxguide/inter-keyboard).
 */
const MODIFIER_ORDER: Record<ShortcutPlatform, readonly ModifierId[]> = {
  mac: ["control", "alt", "shift", "command"],
  windows: ["command", "control", "alt", "shift"],
};

const modifierId = (
  token: string,
  platform: ShortcutPlatform,
): ModifierId | null => {
  const id = MODIFIER_IDS[token.toLowerCase()];
  if (id === undefined) {
    return null;
  }
  if (id === "platform") {
    return platform === "mac" ? "command" : "control";
  }
  return id;
};

/**
 * Put an accelerator's tokens in the order the platform writes them: modifiers
 * first in the platform's fixed order, then the key. An accelerator is a
 * binding rather than a rendering, so `"CmdOrCtrl+Shift+N"` and
 * `"Shift+CmdOrCtrl+N"` are the same shortcut and have to read the same way.
 */
const orderTokens = (
  tokens: string[],
  platform: ShortcutPlatform,
): string[] => {
  const order = MODIFIER_ORDER[platform];
  const modifiers: string[] = [];
  const keys: string[] = [];
  for (const token of tokens) {
    if (modifierId(token, platform)) {
      modifiers.push(token);
    } else {
      keys.push(token);
    }
  }
  modifiers.sort(
    (a, b) =>
      order.indexOf(modifierId(a, platform)!) -
      order.indexOf(modifierId(b, platform)!),
  );
  return [...modifiers, ...keys];
};

/**
 * Parse an Electron accelerator into the display label for each key cap, in
 * the order the platform writes them.
 * Exported so non-visual consumers (tests, aria labels) can reuse the mapping.
 * `platform` defaults to the detected host.
 */
export const parseAccelerator = (
  accelerator: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string[] =>
  orderTokens(tokenize(accelerator), platform).map((token) =>
    displayToken(token, platform),
  );

/**
 * Compact inline form for tooltips and hints: glyphs run together on macOS
 * (`⇧⌘N`), text labels are `+`-joined on Windows (`Ctrl+Shift+N`).
 */
export const formatAcceleratorHint = (
  accelerator: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string =>
  parseAccelerator(accelerator, platform).join(platform === "mac" ? "" : "+");

/**
 * Modifier names [`aria-keyshortcuts`](https://www.w3.org/TR/wai-aria-1.2/#aria-keyshortcuts)
 * takes, which are the UI Events modifier key values rather than the glyphs a
 * menu draws. `CmdOrCtrl` resolves per platform exactly as the glyphs do, so
 * what a screen reader announces matches what the row shows.
 */
const ARIA_MODIFIERS: Record<ShortcutPlatform, Record<string, string>> = {
  mac: {
    command: "Meta",
    cmd: "Meta",
    commandorcontrol: "Meta",
    cmdorctrl: "Meta",
    super: "Meta",
    meta: "Meta",
    control: "Control",
    ctrl: "Control",
    alt: "Alt",
    option: "Alt",
    altgr: "AltGraph",
    shift: "Shift",
  },
  windows: {
    command: "Meta",
    cmd: "Meta",
    commandorcontrol: "Control",
    cmdorctrl: "Control",
    super: "Meta",
    meta: "Meta",
    control: "Control",
    ctrl: "Control",
    alt: "Alt",
    option: "Alt",
    altgr: "AltGraph",
    shift: "Shift",
  },
};

/**
 * Named keys as their UI Events `KeyboardEvent.key` values, for the ones an
 * accelerator spells differently. Keys an accelerator already spells the UI
 * Events way (`F5`, `Insert`, the punctuation keys) are absent and pass
 * through untouched.
 */
const ARIA_KEYS: Record<string, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  return: "Enter",
  enter: "Enter",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  plus: "+",
  capslock: "CapsLock",
  numlock: "NumLock",
  scrolllock: "ScrollLock",
  printscreen: "PrintScreen",
  // The numpad keys announce as the character they produce.
  num0: "0",
  num1: "1",
  num2: "2",
  num3: "3",
  num4: "4",
  num5: "5",
  num6: "6",
  num7: "7",
  num8: "8",
  num9: "9",
  numdec: ".",
  numadd: "+",
  numsub: "-",
  nummult: "*",
  numdiv: "/",
  insert: "Insert",
  // Electron's media and volume names differ from the UI Events values, which
  // is the one place passing the token through would emit something assistive
  // technology does not recognise.
  volumeup: "AudioVolumeUp",
  volumedown: "AudioVolumeDown",
  volumemute: "AudioVolumeMute",
  medianexttrack: "MediaTrackNext",
  mediaprevioustrack: "MediaTrackPrevious",
  mediastop: "MediaStop",
  mediaplaypause: "MediaPlayPause",
};

/**
 * The `aria-keyshortcuts` value for an accelerator: `"CmdOrCtrl+Shift+P"`
 * becomes `"Shift+Meta+P"` on macOS and `"Control+Shift+P"` on Windows,
 * modifiers in the platform's order so the announced binding reads the same
 * way as the drawn one.
 *
 * Menus draw the glyph form and hide it from assistive tech, so this is the
 * only channel through which a screen reader learns the binding. Derived from
 * the same accelerator the glyphs come from, so the two cannot disagree.
 */
/**
 * A key {@link ARIA_KEYS} does not name, as its UI Events value.
 *
 * A single character announces uppercase, which is what the attribute's own
 * examples use, and a function key normalises its own case. Anything else is
 * returned as written: the accelerator grammar accepts named keys in any case,
 * so {@link ARIA_KEYS} carries every one whose canonical spelling this cannot
 * recover, and reaching here otherwise means a key the grammar does not accept.
 *
 * The drawn glyphs are hidden, so whatever this returns is the only thing a
 * screen reader has.
 */
const FUNCTION_KEY = /^f([1-9]|1\d|2[0-4])$/;

const ariaKeyFallback = (token: string): string => {
  if (token.length === 1) {
    return token.toUpperCase();
  }
  const lower = token.toLowerCase();
  if (FUNCTION_KEY.test(lower)) {
    return lower.toUpperCase();
  }
  return token;
};

export const acceleratorToAriaKeyShortcuts = (
  accelerator: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string =>
  orderTokens(tokenize(accelerator), platform)
    .map((token) => {
      const lower = token.toLowerCase();
      return (
        ARIA_MODIFIERS[platform][lower] ??
        ARIA_KEYS[lower] ??
        ariaKeyFallback(token)
      );
    })
    .join("+");

export interface ShortcutKeysProps extends ComponentProps<"span"> {
  /** Electron accelerator string, e.g. `"CmdOrCtrl+Shift+N"`. */
  accelerator: string;
  /** Key-cap vocabulary; defaults to the detected host. */
  platform?: ShortcutPlatform;
  /**
   * `"caps"` draws one boxed key per token, for a surface where the binding is
   * the subject of the row (the Keyboard Shortcuts settings, where it is also
   * being edited). `"inline"` draws the compact glyph run a dense row has space
   * for, which is what a menu or a palette wants beside a command's name.
   */
  variant?: "caps" | "inline";
}

export function ShortcutKeys({
  accelerator,
  platform,
  className,
  variant = "caps",
  ref,
  ...rest
}: ShortcutKeysProps) {
  const caps = parseAccelerator(accelerator, platform);

  if (variant === "inline") {
    return (
      <span
        {...rest}
        ref={ref}
        data-slot="shortcut-keys"
        data-variant="inline"
        className={cn(
          "text-body-small-default tracking-wide",
          "text-[color:var(--content-tertiary)]",
          className,
        )}
      >
        {formatAcceleratorHint(accelerator, platform)}
      </span>
    );
  }

  return (
    <span
      {...rest}
      ref={ref}
      data-slot="shortcut-keys"
      className={cn("inline-flex items-center gap-1", className)}
    >
      {caps.map((cap, index) => (
        <kbd
          // Caps are positional and can repeat (e.g. two identical modifiers
          // are already rejected upstream), so the index is a stable key here.
          key={`${cap}-${index}`}
          className={cn(
            "inline-flex items-center justify-center",
            "min-w-5 h-5 px-1 rounded-[4px]",
            "text-body-small-emphasised leading-none",
            "bg-[var(--tag-bg-neutral)] text-[color:var(--content-default)]",
          )}
        >
          {cap}
        </kbd>
      ))}
    </span>
  );
}
