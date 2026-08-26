import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ShortcutKeys,
  formatAcceleratorHint,
  parseAccelerator,
} from "./shortcut-keys";

describe("parseAccelerator", () => {
  test("maps modifiers to macOS symbols", () => {
    expect(parseAccelerator("CmdOrCtrl+Shift+N")).toEqual([
      "\u2318",
      "\u21e7",
      "N",
    ]);
    expect(parseAccelerator("Command+Control+Alt+K")).toEqual([
      "\u2318",
      "\u2303",
      "\u2325",
      "K",
    ]);
  });

  test("maps named keys to their glyphs", () => {
    expect(parseAccelerator("CmdOrCtrl+Up")).toEqual(["\u2318", "\u2191"]);
    expect(parseAccelerator("CmdOrCtrl+Down")).toEqual(["\u2318", "\u2193"]);
    expect(parseAccelerator("Escape")).toEqual(["\u238b"]);
  });

  test("uppercases single-character keys", () => {
    expect(parseAccelerator("CmdOrCtrl+a")).toEqual(["\u2318", "A"]);
  });

  test("preserves a trailing plus as the literal plus key", () => {
    expect(parseAccelerator("CmdOrCtrl+")).toEqual(["\u2318", "+"]);
    expect(parseAccelerator("CmdOrCtrl+Plus")).toEqual(["\u2318", "+"]);
  });

  test("returns an empty array for an empty accelerator", () => {
    expect(parseAccelerator("")).toEqual([]);
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

describe("formatAcceleratorHint", () => {
  test("runs glyphs together on mac and plus-joins labels on Windows", () => {
    expect(formatAcceleratorHint("CmdOrCtrl+Shift+O", "mac")).toBe(
      "\u2318\u21e7O",
    );
    expect(formatAcceleratorHint("CmdOrCtrl+Shift+O", "windows")).toBe(
      "Ctrl+Shift+O",
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

  test("renders nothing for a disabled (empty) binding", () => {
    const html = renderToStaticMarkup(
      createElement(ShortcutKeys, { accelerator: "" }),
    );
    expect(html).not.toContain("<kbd");
  });
});
