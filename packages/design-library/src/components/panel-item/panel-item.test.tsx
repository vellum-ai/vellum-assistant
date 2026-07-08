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

function renderRow(trailingAction = createElement("button", {}, "⋯")): string {
  return renderToStaticMarkup(
    createElement(PanelItem, {
      label: "Row",
      onSelect: () => {},
      trailingAction,
    }),
  );
}

describe("PanelItem trailing action", () => {
  test("is hidden by default and revealed on hover", () => {
    const html = renderRow();
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover:opacity-100");
  });

  test("is revealed on focus-within so keyboard users can reach it", () => {
    const html = renderRow();
    expect(html).toContain("group-focus-within:opacity-100");
  });

  test("stays visible while its menu is open (aria-expanded trigger)", () => {
    const html = renderRow();
    expect(html).toContain("has-[[aria-expanded=true]]:opacity-100");
  });

  test("stays visible on touch devices, which have no hover to reveal it", () => {
    expect(renderRow()).toContain("touch-mobile:opacity-100");
  });

  test("stays visible on the active row", () => {
    const html = renderRow();
    expect(html).toContain("group-aria-[current=page]:opacity-100");
  });
});
