/**
 * Tests for the PanelItem primitive.
 *
 * Renders to static markup via `react-dom/server` and asserts on the
 * emitted HTML — no DOM testing library required.
 */

import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
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

  test("stays visible where the device cannot hover", () => {
    // The reveal is keyed on the hover capability it depends on, not on the
    // pointer beside it: the two are independent media features, and it is
    // the missing hover that makes a hover-revealed action unreachable.
    // Callers that already have their own touch affordance (long-press,
    // swipe) simply don't pass `trailingAction` on touch, rather than
    // asking PanelItem to hide one it was given, see conversation-row.tsx.
    expect(renderRow()).toContain("[@media(hover:none)]:opacity-100");
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

  test("yields the slot where there is no hover, since the action is shown there", () => {
    // The badge and the trailing action crossfade in one cell, so the badge
    // has to leave under exactly the conditions that bring the action in.
    // Where the device cannot hover the action is permanently shown, so a
    // badge that only left on hover would sit underneath it.
    const html = renderWithBadge(false, createElement("button", {}, "⋯"));
    expect(html).toContain("[@media(hover:none)]:opacity-0");
  });
});

describe("PanelItem shape", () => {
  function renderShaped(shape?: "row" | "pill", className?: string): string {
    return renderToStaticMarkup(
      createElement(PanelItem, {
        label: "Row",
        onSelect: () => {},
        shape,
        className,
      }),
    );
  }

  test("defaults to a full-width row", () => {
    const html = renderShaped();
    expect(html).toContain("rounded-[6px]");
    expect(html).toContain("w-full");
    expect(html).not.toContain("rounded-full");
  });

  /* Two failure modes in one assertion.

     The row's radius and width must be *replaced*, not merely joined by the
     pill's: emitting both leaves the winner to stylesheet order, which is how
     a capsule silently renders as a 6px row.

     And the replacement must be an intrinsic width. The root is a block-level
     flex container, so `width: auto` resolves to the containing block and the
     pill stretches to row width in any ordinary layout. A story cannot stand
     in for this check: a parent that shrink-wraps its children supplies the
     behavior externally and hides the defect. */
  test("pill replaces the row's radius and width with an intrinsic width", () => {
    const html = renderShaped("pill");
    expect(html).toContain("rounded-full");
    expect(html).toContain("w-fit");
    expect(html).not.toContain("rounded-[6px]");
    expect(html).not.toContain("w-full");
    expect(html).not.toContain("w-auto");
  });

  /* The other half of the split. Without it, collapsing both shapes back onto
     one fallback would leave the pill test passing on its own terms while the
     row silently changed. */
  test("a row hovers to the overlay built for its transparent rest", () => {
    const html = renderShaped();
    expect(html).toContain(
      "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-hover))]",
    );
    expect(html).not.toContain(
      "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-active))]",
    );
  });

  /* A pill hovers to `--surface-active`, not to `--surface-hover` like a row.
     `--surface-hover` is a 6% translucent overlay built for a transparent
     base; a pill rests on `--surface-lift`, so that overlay composites darker
     than the resting surface and the pill reads as having no hover at all.
     Asserted as the exact class, since the failure it guards against is the
     row's fallback being used here. */
  test("pill keeps the row's interaction treatment", () => {
    const html = renderShaped("pill");
    expect(html).toContain(
      "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-active))]",
    );
    /* The active surface reads the tint properties too, so a tinted pill stays
       tinted while it is the current page instead of the `aria-current` rule
       winning over the resting tint. */
    expect(html).toContain(
      "aria-[current=page]:bg-[var(--panel-item-active,var(--panel-item-bg,var(--surface-active)))]",
    );
  });

  /* A pill stands taller than a row, and it takes that height from the panel
     it is mounted in rather than from a caller: `SideMenu` publishes
     `--side-menu-tile-size` and draws its collapsed tiles at it, so a pill and
     the circle it collapses into cannot end up at two heights. Asserted with
     the row's height absent, since the pill's has to *replace* it: emitting
     both leaves the winner to stylesheet order.

     `max-md:h-auto` survives, and has to: on a touch-sized viewport a pill
     grows to its own padding like every other row. */
  test("pill takes its height from the panel, replacing the row's", () => {
    const html = renderShaped("pill");
    expect(html).toContain("h-[var(--side-menu-tile-size,36px)]");
    expect(html).toContain("max-md:h-auto");
    expect(html).not.toContain("h-8");
  });

  /* Consumers override the shape's surface, so their className has to win
     over PILL_SHAPE_CLASSES. */
  test("a consumer className overrides the pill surface", () => {
    const html = renderShaped("pill", "bg-[var(--surface-active)]");
    expect(html).toContain("bg-[var(--surface-active)]");
    expect(html).not.toContain("bg-[var(--panel-item-bg,var(--surface-lift))]");
  });

  /* A tinted pill (the assistant identity, New Chat) declares colours as
     custom properties on an ancestor rather than passing this component a
     colour or overriding its classes. Every reference carries the untinted
     value as its fallback, so a pill with nothing declaring them is
     unchanged - which is what keeps this additive for existing consumers. */
  test("the pill reads tint custom properties, falling back to the plain surface", () => {
    const html = renderShaped("pill");
    expect(html).toContain("bg-[var(--panel-item-bg,var(--surface-lift))]");
    expect(html).toContain("text-[color:var(--panel-item-fg,inherit)]");
    expect(html).toContain(
      "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-active))]",
    );
  });
});

describe("PanelItem asChild", () => {
  /* The row is a state layer over the caller's element: the geometry and the
     interactive treatment have to land on that element, since nothing else is
     rendered to carry them. */
  test("merges the row's geometry and interactive treatment onto the child", () => {
    const html = renderToStaticMarkup(
      createElement(
        PanelItem,
        { asChild: true, active: true },
        createElement("a", { href: "/pinned" }, "Pinned"),
      ),
    );
    expect(html).toContain('<a href="/pinned"');
    expect(html).toContain("group/panel-item");
    expect(html).toContain("cursor-pointer");
    expect(html).toContain('aria-current="page"');
  });

  /* Radix `Slot` skips both the prop merge and the ref composition for a
     fragment, so a fragment child renders a row with none of the above and
     holds no ref. The type cannot express that, so it is reported. */
  test("reports a fragment child, which the slot cannot merge onto", () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args[0]);
    };
    try {
      renderToStaticMarkup(
        createElement(
          PanelItem,
          { asChild: true },
          createElement(Fragment, null, "Pinned"),
        ),
      );
    } finally {
      console.error = original;
    }
    expect(errors.some((message) => String(message).includes("PanelItem"))).toBe(
      true,
    );
  });
});
