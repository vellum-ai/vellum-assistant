import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ShortcutKeys, parseAccelerator } from "./shortcut-keys";

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

  test("renders nothing for a disabled (empty) binding", () => {
    const html = renderToStaticMarkup(
      createElement(ShortcutKeys, { accelerator: "" }),
    );
    expect(html).not.toContain("<kbd");
  });
});
