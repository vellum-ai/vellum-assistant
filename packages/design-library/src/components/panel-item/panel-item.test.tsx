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
): string {
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

  test("stays visible on touch devices (no hover to reveal it)", () => {
    // Callers that already have their own touch affordance (long-press,
    // swipe) simply don't pass `trailingAction` on touch, rather than
    // asking PanelItem to hide one it was given, see conversation-row.tsx.
    expect(renderRow()).toContain("pointer-coarse:opacity-100");
  });

  test("stays visible on the active row", () => {
    const html = renderRow();
    expect(html).toContain("group-aria-[current=page]:opacity-100");
  });
});

describe("PanelItem badge", () => {
  function renderWithBadge(
    badgeBare?: boolean,
    trailingAction?: ReturnType<typeof createElement>,
  ): string {
    return renderToStaticMarkup(
      createElement(PanelItem, {
        label: "Row",
        onSelect: () => {},
        badge: createElement("span", null, "3"),
        badgeBare,
        trailingAction,
      }),
    );
  }

  test("is pill-styled by default", () => {
    const html = renderWithBadge();
    expect(html).toContain("bg-[var(--surface-base)]");
    expect(html).toContain("rounded-[4px]");
  });

  test("drops the pill chrome when badgeBare is set", () => {
    const html = renderWithBadge(true);
    expect(html).not.toContain("bg-[var(--surface-base)]");
    expect(html).not.toContain("rounded-[4px]");
    // Still renders the badge content itself.
    expect(html).toContain(">3<");
  });

  test("a bare badge alone gets an 8px inset from the row's edge", () => {
    const html = renderWithBadge(true);
    expect(html).toContain("mr-2");
  });

  test("a bare badge next to a trailing action skips the extra inset (gap-2 already separates them)", () => {
    const html = renderWithBadge(true, createElement("button", {}, "⋯"));
    expect(html).not.toContain("mr-2");
  });
});

