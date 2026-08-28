import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ShortcutKeys,
  acceleratorToAriaKeyShortcuts,
  detectShortcutPlatform,
  formatAcceleratorHint,
  parseAccelerator,
} from "./shortcut-keys";

describe("parseAccelerator", () => {
  test("maps modifiers to macOS symbols", () => {
    expect(parseAccelerator("CmdOrCtrl+Shift+N", "mac")).toEqual([
      "\u21e7",
      "\u2318",
      "N",
    ]);
    expect(parseAccelerator("Command+Control+Alt+K", "mac")).toEqual([
      "\u2303",
      "\u2325",
      "\u2318",
      "K",
    ]);
  });

  test("maps named keys to their glyphs", () => {
    expect(parseAccelerator("CmdOrCtrl+Up", "mac")).toEqual([
      "\u2318",
      "\u2191",
    ]);
    expect(parseAccelerator("CmdOrCtrl+Down", "mac")).toEqual([
      "\u2318",
      "\u2193",
    ]);
    expect(parseAccelerator("Escape", "mac")).toEqual(["\u238b"]);
  });

  test("uppercases single-character keys", () => {
    expect(parseAccelerator("CmdOrCtrl+a", "mac")).toEqual(["\u2318", "A"]);
  });

  test("preserves a trailing plus as the literal plus key", () => {
    expect(parseAccelerator("CmdOrCtrl+", "mac")).toEqual(["\u2318", "+"]);
    expect(parseAccelerator("CmdOrCtrl+Plus", "mac")).toEqual(["\u2318", "+"]);
  });

  test("returns an empty array for an empty accelerator", () => {
    expect(parseAccelerator("", "mac")).toEqual([]);
  });

  test("writes macOS modifiers in the Apple order, not the accelerator's", () => {
    // Apple Style Guide: Control, Option, Shift, Command. The accelerator is a
    // binding, so every spelling of one shortcut has to render identically.
    const spellings = [
      "Control+Alt+Shift+Cmd+K",
      "Cmd+Shift+Alt+Control+K",
      "Shift+Control+Cmd+Alt+K",
    ];
    for (const spelling of spellings) {
      expect(parseAccelerator(spelling, "mac")).toEqual([
        "\u2303",
        "\u2325",
        "\u21e7",
        "\u2318",
        "K",
      ]);
    }
  });

  test("leads with the Windows key, then Ctrl, Alt, Shift", () => {
    expect(parseAccelerator("Shift+Alt+Control+Super+K", "windows")).toEqual([
      "Win",
      "Ctrl",
      "Alt",
      "Shift",
      "K",
    ]);
  });

  test("orders CmdOrCtrl by what it resolves to on the host", () => {
    // It ranks last on macOS as Command and second on Windows as Ctrl, so the
    // same accelerator sorts differently per platform.
    expect(parseAccelerator("CmdOrCtrl+Shift+K", "mac")).toEqual([
      "\u21e7",
      "\u2318",
      "K",
    ]);
    expect(parseAccelerator("CmdOrCtrl+Shift+K", "windows")).toEqual([
      "Ctrl",
      "Shift",
      "K",
    ]);
  });

  test("keeps the key last even when it sorts before a modifier", () => {
    expect(parseAccelerator("A+Shift", "mac")).toEqual(["\u21e7", "A"]);
    expect(parseAccelerator("CmdOrCtrl+", "mac")).toEqual(["\u2318", "+"]);
  });

  test("maps tokens to text labels on Windows", () => {
    expect(parseAccelerator("CmdOrCtrl+Shift+N", "windows")).toEqual([
      "Ctrl",
      "Shift",
      "N",
    ]);
    expect(parseAccelerator("Super+Alt+Escape", "windows")).toEqual([
      "Win",
      "Alt",
      "Esc",
    ]);
    expect(parseAccelerator("Control+Up", "windows")).toEqual([
      "Ctrl",
      "\u2191",
    ]);
  });
});

describe("detectShortcutPlatform", () => {
  const platforms: [string, ReturnType<typeof detectShortcutPlatform>][] = [
    ["MacIntel", "mac"],
    ["X11; Darwin arm64", "mac"],
    ["iPhone", "mac"],
    ["Win32", "windows"],
    ["Linux x86_64", "windows"],
    ["", "mac"],
  ];
  for (const [platform, expected] of platforms) {
    test(`${JSON.stringify(platform)} resolves to ${expected}`, () => {
      const original = navigator.platform;
      Object.defineProperty(navigator, "platform", {
        value: platform,
        configurable: true,
      });
      try {
        expect(detectShortcutPlatform()).toBe(expected);
      } finally {
        Object.defineProperty(navigator, "platform", {
          value: original,
          configurable: true,
        });
      }
    });
  }
});

describe("formatAcceleratorHint", () => {
  test("runs glyphs together on mac and plus-joins labels on Windows", () => {
    expect(formatAcceleratorHint("CmdOrCtrl+Shift+O", "mac")).toBe(
      "\u21e7\u2318O",
    );
    expect(formatAcceleratorHint("CmdOrCtrl+Shift+O", "windows")).toBe(
      "Ctrl+Shift+O",
    );
  });
});

describe("acceleratorToAriaKeyShortcuts", () => {
  test("announces modifiers in the same order the row draws them", () => {
    expect(acceleratorToAriaKeyShortcuts("CmdOrCtrl+Shift+P", "mac")).toBe(
      "Shift+Meta+P",
    );
    expect(acceleratorToAriaKeyShortcuts("CmdOrCtrl+Shift+P", "windows")).toBe(
      "Control+Shift+P",
    );
  });

  test("is stable across spellings of one binding", () => {
    expect(acceleratorToAriaKeyShortcuts("Shift+CmdOrCtrl+P", "mac")).toBe(
      acceleratorToAriaKeyShortcuts("CmdOrCtrl+Shift+P", "mac"),
    );
  });

  test("names every key a rebind can produce, without shouting it", () => {
    // The drawn glyphs are hidden, so this string is the only announcement.
    // Uppercasing a named key emits a value no assistive tech recognises.
    expect(acceleratorToAriaKeyShortcuts("CmdOrCtrl+Insert", "mac")).toBe(
      "Meta+Insert",
    );
    expect(acceleratorToAriaKeyShortcuts("CmdOrCtrl+F5", "mac")).toBe(
      "Meta+F5",
    );
    expect(acceleratorToAriaKeyShortcuts("CmdOrCtrl+Capslock", "mac")).toBe(
      "Meta+CapsLock",
    );
    // A numpad key announces the character it produces.
    expect(acceleratorToAriaKeyShortcuts("CmdOrCtrl+num7", "mac")).toBe(
      "Meta+7",
    );
    expect(acceleratorToAriaKeyShortcuts("CmdOrCtrl+numdec", "mac")).toBe(
      "Meta+.",
    );
    // Punctuation is already its own key value.
    expect(acceleratorToAriaKeyShortcuts("CmdOrCtrl+[", "mac")).toBe("Meta+[");
    // A single letter announces uppercase, matching the attribute's examples.
    expect(acceleratorToAriaKeyShortcuts("CmdOrCtrl+a", "mac")).toBe("Meta+A");
  });

  test("uses UI Events key values rather than glyphs", () => {
    expect(acceleratorToAriaKeyShortcuts("CmdOrCtrl+Up", "mac")).toBe(
      "Meta+ArrowUp",
    );
    expect(acceleratorToAriaKeyShortcuts("Alt+Return", "windows")).toBe(
      "Alt+Enter",
    );
  });
});

describe("ShortcutKeys", () => {
  test("renders one kbd cap per token", () => {
    const html = renderToStaticMarkup(
      createElement(ShortcutKeys, { accelerator: "CmdOrCtrl+Shift+N" }),
    );
    const caps = html.match(/<kbd/g) ?? [];
    expect(caps).toHaveLength(3);
    expect(html).toContain('data-slot="shortcut-keys"');
  });

  test("renders platform labels when asked", () => {
    const html = renderToStaticMarkup(
      createElement(ShortcutKeys, {
        accelerator: "CmdOrCtrl+K",
        platform: "windows",
      }),
    );
    expect(html).toContain(">Ctrl<");
  });

  test("the inline variant draws the compact hint in one element", () => {
    const html = renderToStaticMarkup(
      createElement(ShortcutKeys, {
        accelerator: "CmdOrCtrl+Shift+N",
        platform: "mac",
        variant: "inline",
      }),
    );
    // One span, no key caps: the caps form is for a surface where the binding
    // is the subject of the row.
    expect(html).not.toContain("<kbd");
    expect(html).toContain('data-slot="shortcut-keys"');
    expect(html).toContain('data-variant="inline"');
    expect(html).toContain("\u21e7\u2318N");
  });

  test("renders nothing for a disabled (empty) binding", () => {
    const html = renderToStaticMarkup(
      createElement(ShortcutKeys, { accelerator: "" }),
    );
    expect(html).not.toContain("<kbd");
  });
});
