/**
 * Tests for the PanelItem primitive.
 *
 * Renders to static markup via `react-dom/server` and asserts on the
 * emitted HTML — no DOM testing library required.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PanelItem } from "./panel-item";

function renderRow(
  trailingAction = createElement("button", {}, "⋯"),
  hideTrailingActionOnTouch = false,
): string {
  return renderToStaticMarkup(
    createElement(PanelItem, {
      label: "Row",
      onSelect: () => {},
      trailingAction,
      hideTrailingActionOnTouch,
    }),
  );
}

describe("PanelItem trailing action", () => {
  test("is hidden by default and revealed on hover", () => {
    const html = renderRow();
    expect(html).toContain("opacity-0");
    expect(html).toContain("[@media(hover:hover)]:group-hover:opacity-100");
  });

  test("is revealed on focus-within so keyboard users can reach it", () => {
    const html = renderRow();
    expect(html).toContain("group-focus-within:opacity-100");
  });

  test("stays visible while its menu is open (aria-expanded trigger)", () => {
    const html = renderRow();
    expect(html).toContain("has-[[aria-expanded=true]]:opacity-100");
  });

  test("stays visible on touch devices by default (no hover to reveal it)", () => {
    expect(renderRow()).toContain("pointer-coarse:opacity-100");
  });

  test("is hidden on touch when hideTrailingActionOnTouch is set (caller has long-press + swipe)", () => {
    const html = renderRow(undefined, true);
    expect(html).not.toContain("pointer-coarse:opacity-100");
  });

  test("disables pointer events on touch when hideTrailingActionOnTouch is set (taps pass through to the row)", () => {
    const html = renderRow(undefined, true);
    expect(html).toContain("pointer-coarse:pointer-events-none");
  });

  test("keeps pointer events on touch by default (trailing action is visible and tappable)", () => {
    expect(renderRow()).not.toContain("pointer-coarse:pointer-events-none");
  });

  test("stays visible on the active row", () => {
    const html = renderRow();
    expect(html).toContain("group-aria-[current=page]:opacity-100");
  });
});

