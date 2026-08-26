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

/**
 * Parse an Electron accelerator into the display label for each key cap.
 * Exported so non-visual consumers (tests, aria labels) can reuse the mapping.
 * `platform` defaults to the detected host.
 */
export const parseAccelerator = (
  accelerator: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string[] =>
  tokenize(accelerator).map((token) => displayToken(token, platform));

/**
 * Compact inline form for tooltips and hints: glyphs run together on macOS
 * (`⌘⇧N`), text labels are `+`-joined on Windows (`Ctrl+Shift+N`).
 */
export const formatAcceleratorHint = (
  accelerator: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string =>
  parseAccelerator(accelerator, platform).join(platform === "mac" ? "" : "+");

export interface ShortcutKeysProps extends ComponentProps<"span"> {
  /** Electron accelerator string, e.g. `"CmdOrCtrl+Shift+N"`. */
  accelerator: string;
  /** Key-cap vocabulary; defaults to the detected host. */
  platform?: ShortcutPlatform;
}

export function ShortcutKeys({
  accelerator,
  platform,
  className,
  ref,
  ...rest
}: ShortcutKeysProps) {
  const caps = parseAccelerator(accelerator, platform);
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
