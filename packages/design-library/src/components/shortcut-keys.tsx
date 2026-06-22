import { type ComponentProps } from "react";

import { cn } from "../utils/cn";

/**
 * Renders an Electron [`Accelerator`](https://www.electronjs.org/docs/latest/api/accelerator)
 * string as a row of macOS-style key caps (e.g. `"CmdOrCtrl+Shift+N"` →
 * ⌘ ⇧ N). Presentation-only: it does not capture or validate input, so it is
 * reusable anywhere a binding needs to be shown (Keyboard Shortcuts settings,
 * a future command palette, menu hints).
 *
 * Modifier and named-key tokens are mapped to the symbols macOS uses; an empty
 * accelerator renders nothing, which callers use to show a "disabled" binding.
 */

const MODIFIER_SYMBOLS: Record<string, string> = {
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

const KEY_SYMBOLS: Record<string, string> = {
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

/** Convert one accelerator token to its display glyph. */
const displayToken = (token: string): string => {
  const lower = token.toLowerCase();
  return (
    MODIFIER_SYMBOLS[lower] ?? KEY_SYMBOLS[lower] ?? token.toUpperCase()
  );
};

/**
 * Parse an Electron accelerator into the display glyphs for each key cap.
 * Exported so non-visual consumers (tests, aria labels) can reuse the mapping.
 */
export const parseAccelerator = (accelerator: string): string[] =>
  tokenize(accelerator).map(displayToken);

export interface ShortcutKeysProps extends ComponentProps<"span"> {
  /** Electron accelerator string, e.g. `"CmdOrCtrl+Shift+N"`. */
  accelerator: string;
}

export function ShortcutKeys({
  accelerator,
  className,
  ref,
  ...rest
}: ShortcutKeysProps) {
  const caps = parseAccelerator(accelerator);
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
