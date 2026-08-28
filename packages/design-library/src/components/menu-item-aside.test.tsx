import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MenuItemShortcut,
  MenuItemTrailing,
  menuItemShortcutProps,
} from "./menu-item-aside";

/**
 * The row's two right-aligned slots carry opposite accessibility meanings, and
 * the whole point of drawing a key hint from an accelerator is that the drawn
 * glyphs and the announced binding come from one value. These pin that
 * contract at the markup level, where a regression would otherwise only be
 * visible to a screen reader.
 */

describe("menuItemShortcutProps", () => {
  test("announces the binding whenever a row draws one", () => {
    expect(menuItemShortcutProps("CmdOrCtrl+Shift+P")).toEqual({
      "aria-keyshortcuts": expect.any(String),
    });
  });

  test("announces nothing when the row has no binding", () => {
    expect(menuItemShortcutProps(undefined)).toEqual({});
  });

  test("resolves CmdOrCtrl per platform, matching the drawn glyphs", () => {
    // The value is platform-dependent for the same reason the glyph is: a row
    // showing ⌘ must not announce Control.
    const mac = renderToStaticMarkup(
      <MenuItemShortcut accelerator="CmdOrCtrl+Shift+P" />,
    );
    expect(mac).toContain("aria-hidden");
    expect(
      menuItemShortcutProps("CmdOrCtrl+Shift+P")["aria-keyshortcuts"],
    ).toMatch(/^(Shift\+Meta|Control\+Shift)\+P$/);
  });
});

describe("MenuItemShortcut", () => {
  test("draws the accelerator and hides the glyphs from assistive tech", () => {
    const html = renderToStaticMarkup(
      <MenuItemShortcut accelerator="CmdOrCtrl+Shift+P" />,
    );
    expect(html).toContain('data-slot="menu-item-shortcut"');
    expect(html).toContain('aria-hidden="true"');
    // The glyph form, never the raw accelerator.
    expect(html).not.toContain("CmdOrCtrl");
  });

  test("pushes to the right edge unless a trailing slot already has", () => {
    expect(
      renderToStaticMarkup(<MenuItemShortcut accelerator="CmdOrCtrl+D" />),
    ).toContain("ml-auto");
    expect(
      renderToStaticMarkup(
        <MenuItemShortcut accelerator="CmdOrCtrl+D" push={false} />,
      ),
    ).not.toContain("ml-auto");
  });
});

describe("MenuItemTrailing", () => {
  test("stays in the accessible name", () => {
    const html = renderToStaticMarkup(
      <MenuItemTrailing>Copy link</MenuItemTrailing>,
    );
    expect(html).toContain('data-slot="menu-item-trailing"');
    expect(html).toContain("Copy link");
    expect(html).not.toContain("aria-hidden");
  });
});
