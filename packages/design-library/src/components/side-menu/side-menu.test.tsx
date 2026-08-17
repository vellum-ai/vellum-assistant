/**
 * Tests for the SideMenu primitive.
 *
 * Renders to static markup via `react-dom/server` and asserts on the
 * emitted HTML — no DOM testing library required.
 */

import { describe, expect, mock, test } from "bun:test";
import { Globe } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SIDE_MENU_BORDER_WIDTH,
  SIDE_MENU_COLLAPSED_INSET,
  SIDE_MENU_COLLAPSED_WIDTH,
  SIDE_MENU_TILE_SIZE,
  SideMenu,
  useSideMenuCollapsed,
} from "./side-menu";

describe("SideMenu root", () => {
  test("renders a <nav> with the provided aria-label and data-slot", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(SideMenu.Body, { key: "body" }, null),
      ),
    );
    expect(html).toContain("<nav");
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('data-slot="side-menu"');
  });

  test("default variant is rail with expanded width", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(SideMenu.Body, { key: "body" }, null),
      ),
    );
    expect(html).toContain("w-[230px]");
    expect(html).toContain("rounded-[12px]");
    expect(html).toContain("bg-[var(--surface-overlay)]");
  });

  test("collapsed rail is one tile of content plus its own chrome", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(SideMenu.Body, { key: "body" }, null),
      ),
    );
    /* `box-content` is the whole point of the pairing: it makes the padding
       and border the rail actually renders decide the outer width, so a
       caller that turns that chrome off gets a rail exactly one tile wide
       rather than one carrying room for padding it never draws. Room the
       tile does not fill is room it centres in, and every glyph then steps
       inward when the rail collapses. */
    expect(html).toContain("box-content");
    expect(html).toContain("w-[var(--side-menu-tile-size)]");
    expect(html).toContain(`--side-menu-tile-size:${SIDE_MENU_TILE_SIZE}px`);
    expect(html).not.toContain("w-[230px]");
  });

  /* The JS constant is for callers that need the collapsed width as a number
     and keep the rail's default chrome. It has to agree with what that chrome
     renders, border included: the rail is a `border-box` element, so a number
     counting only the tile and its padding spends 2px of itself on the edge
     and comes up short of the tile it is supposed to hold. */
  test("collapsed width holds one tile, its padding, and the rail's border", () => {
    expect(SIDE_MENU_TILE_SIZE).toBe(36);
    expect(SIDE_MENU_COLLAPSED_INSET).toBe(8);
    expect(SIDE_MENU_BORDER_WIDTH).toBe(1);
    expect(SIDE_MENU_COLLAPSED_WIDTH).toBe(
      SIDE_MENU_TILE_SIZE +
        SIDE_MENU_COLLAPSED_INSET * 2 +
        SIDE_MENU_BORDER_WIDTH * 2,
    );
  });

  /* Every top-level row resolves its height from this property rather than
     naming the pixels again, which is what keeps a pill and the tile it
     collapses into from disagreeing - a disagreement that stays invisible
     until the rail collapses. Both variants publish it, since an overlay
     holds the same rows. */
  test("both variants publish the tile property rows size from", () => {
    for (const variant of ["rail", "overlay"] as const) {
      const html = renderToStaticMarkup(
        createElement(
          SideMenu,
          { ariaLabel: "Primary", variant },
          createElement(SideMenu.Body, { key: "body" }, null),
        ),
      );
      expect(html).toContain(`--side-menu-tile-size:${SIDE_MENU_TILE_SIZE}px`);
    }
  });

  test("overlay variant is full-bleed with no radius", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", variant: "overlay" },
        createElement(SideMenu.Body, { key: "body" }, null),
      ),
    );
    expect(html).toContain("w-full");
    expect(html).toContain("rounded-none");
  });
});

describe("SideMenu.SectionHeader", () => {
  /* A section header is a top-level rail row, so it stands at the height the
     pills and tiles around it do, and it reads that from the rail rather than
     from a caller's class - a caller free to name the height is a caller free
     to name a different one. */
  test("stands at the rail's row height, growing to its padding when touch-sized", () => {
    const html = renderToStaticMarkup(
      createElement(SideMenu.SectionHeader, null, "Pinned"),
    );
    expect(html).toContain("h-[var(--side-menu-tile-size)]");
    expect(html).toContain("max-md:h-auto");
    expect(html).toContain('data-slot="side-menu-section-header"');
  });

  /* The collapsible variant of the same row is a disclosure trigger, and it
     has to be the same row: taking the geometry through the slot is what
     keeps a section that opens from standing at a different height than one
     that does not. */
  test("hands its geometry to the caller's own element", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu.SectionHeader,
        { asChild: true },
        createElement("button", { type: "button" }, "Pinned"),
      ),
    );
    expect(html).toContain("<button");
    expect(html).toContain("h-[var(--side-menu-tile-size)]");
  });
});

describe("SideMenu collapsed rail content visibility", () => {
  test("section titles and labels are absent from the DOM in collapsed rail mode", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(
            SideMenu.Section,
            { key: "s", title: "Intelligence" },
            createElement(
              SideMenu.SubList,
              { key: "sl" },
              createElement(SideMenu.Item, {
                key: "i",
                icon: Globe,
                label: "Pinned App",
                badge: "3",
              }),
            ),
          ),
        ),
      ),
    );

    expect(html).not.toContain("Intelligence");
    expect(html).not.toContain(">3<");
    expect(html).not.toContain("Pinned App");
  });

  test("collapsed item rendered outside a SubList still hides its label", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(
          SideMenu.Footer,
          { key: "f" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Preferences",
          }),
        ),
      ),
    );
    expect(html).not.toContain(">Preferences<");
    expect(html).toContain('title="Preferences"');
  });
});

describe("SideMenu collapsed-rail tooltips", () => {
  test("plain collapsed item falls back to the native title", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(
          SideMenu.Footer,
          { key: "f" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Preferences",
          }),
        ),
      ),
    );
    expect(html).toContain('title="Preferences"');
  });

  test("showCollapsedTooltip drops the native title in favor of the styled tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(
          SideMenu.Footer,
          { key: "f" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Preferences",
            showCollapsedTooltip: true,
          }),
        ),
      ),
    );
    // No native title, so the browser tooltip and the styled one don't stack
    // into a double tooltip on hover.
    expect(html).not.toContain('title="Preferences"');
  });

  test("custom tooltip text also replaces the native title", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", collapsed: true },
        createElement(
          SideMenu.Footer,
          { key: "f" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Preferences",
            tooltip: "Open preferences",
          }),
        ),
      ),
    );
    expect(html).not.toContain('title="Preferences"');
  });

  test("expanded rail ignores showCollapsedTooltip and keeps the visible label", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Preferences",
            showCollapsedTooltip: true,
          }),
        ),
      ),
    );
    expect(html).toContain("Preferences");
    expect(html).not.toContain('title="Preferences"');
  });
});

describe("SideMenu overlay always shows labels", () => {
  test("overlay ignores `collapsed` and renders labels + titles", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary", variant: "overlay", collapsed: true },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(
            SideMenu.Section,
            { key: "s", title: "Intelligence" },
            createElement(
              SideMenu.SubList,
              { key: "sl" },
              createElement(SideMenu.Item, {
                key: "i",
                icon: Globe,
                label: "Pinned App",
              }),
            ),
          ),
        ),
      ),
    );
    expect(html).toContain("Intelligence");
    expect(html).toContain("Pinned App");
  });
});

describe("SideMenu.Item active / aria-current", () => {
  test("active item sets aria-current=page", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
            active: true,
          }),
        ),
      ),
    );
    expect(html).toContain('aria-current="page"');
  });

  test("inactive item does not set aria-current", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
          }),
        ),
      ),
    );
    expect(html).not.toContain("aria-current");
  });
});

describe("SideMenu.Item typography", () => {
  test("default size uses body-medium-lighter", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
          }),
        ),
      ),
    );
    expect(html).toContain("text-body-medium-lighter");
    expect(html).not.toContain("text-body-small-default");
  });

  test("compact size uses body-small-default", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Thread",
            size: "compact",
          }),
        ),
      ),
    );
    expect(html).toContain("text-body-small-default");
    expect(html).not.toContain("text-body-medium-lighter");
  });

  test("badge chip uses label-small-default", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Inbox",
            badge: "9",
          }),
        ),
      ),
    );
    expect(html).toContain("text-label-small-default");
  });
});

describe("SideMenu.Item rendering", () => {
  test("renders as <button type=button> when no href is given", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
          }),
        ),
      ),
    );
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
  });

  test("renders as <a> when href is provided", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
            href: "/somewhere",
          }),
        ),
      ),
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/somewhere"');
    expect(html).not.toContain("<button");
  });

  test("onSelect prop call contract", () => {
    const onSelect = mock(() => {});
    renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
            onSelect,
          }),
        ),
      ),
    );
    onSelect();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("SideMenu.Item polymorphic icon", () => {
  test("string icon renders the emoji glyph in the leading slot", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: "🚀",
            label: "HQ",
          }),
        ),
      ),
    );
    // The emoji renders inside an aria-hidden inline span, not as a Lucide
    // <svg>. The label remains in its own span.
    expect(html).toContain("🚀");
    expect(html).toContain(">HQ<");
  });

  test("Lucide icon still renders an svg, not a glyph span", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Home",
          }),
        ),
      ),
    );
    expect(html).toContain("<svg");
    expect(html).not.toContain("🚀");
  });

  test("undefined icon renders neither glyph nor svg", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, { key: "i", label: "Bare" }),
        ),
      ),
    );
    expect(html).not.toContain("<svg");
    expect(html).toContain(">Bare<");
  });
});

// ---------------------------------------------------------------------------
// Collapsed-rail tiles: shape, indicator, disabled
// ---------------------------------------------------------------------------

/** A collapsed rail wrapping one item, the only place these props apply. */
function renderCollapsedItem(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(
      SideMenu,
      { ariaLabel: "Primary", collapsed: true },
      createElement(
        SideMenu.Body,
        { key: "body" },
        createElement(SideMenu.Item, { key: "i", icon: Globe, ...props }),
      ),
    ),
  );
}

describe("SideMenu.Item collapsed shape", () => {
  test('shape="tile" fully rounds the collapsed tile', () => {
    const html = renderCollapsedItem({ label: "Pinned", shape: "tile" });
    expect(html).toContain("rounded-full");
    // The 6px row radius is replaced, not stacked underneath it, so the
    // rendered radius can't depend on which class tailwind-merge kept.
    expect(html).not.toContain("rounded-[6px]");
  });

  test('shape="tile" squares the tile, so it is round and not oval', () => {
    const html = renderCollapsedItem({ label: "Pinned", shape: "tile" });
    /* A full radius on a `w-full` row is an ellipse, not a circle: the rail
       column is a little wider than the row is tall. The radius alone is not
       the shape, so assert the square too. A definite `size-*` is what makes
       it one: a height plus `aspect-square` derives the width instead, and a
       derived width is `auto`, which `align-items: stretch` then overrides
       back to the container's. */
    expect(html).toContain("size-[var(--side-menu-tile-size)]");
    expect(html).not.toContain("aspect-square");
  });

  test("a tile is built as its own shape, not as a row with patches", () => {
    const html = renderCollapsedItem({ label: "Pinned", shape: "tile" });
    /* The row classes a tile does not want are absent, rather than present
       and countered. Absence is the property worth asserting: countering them
       with `w-auto` / `max-md:h-[30px]` / `max-md:py-[6px]` renders the same
       while leaving the geometry dependent on tailwind-merge order, one class
       list away from a 32x30 ellipse or a 38x38 tile overflowing the rail. */
    expect(html).not.toContain("w-full");
    expect(html).not.toContain("rounded-[6px]");
    expect(html).not.toContain("max-md:h-auto");
    expect(html).not.toContain("max-md:py-3");
    // ...and no counter-classes, because there is nothing to counter.
    expect(html).not.toContain("w-auto");
    expect(html).not.toContain("max-md:h-[30px]");
    expect(html).not.toContain("max-md:py-[6px]");
  });

  test("an ordinary row keeps the label geometry a tile drops", () => {
    const html = renderCollapsedItem({ label: "Pinned" });
    // The other half of the branch: rows still fill the rail and still grow
    // on narrow viewports, so the tile shape stayed scoped to tiles.
    expect(html).toContain("w-full");
    expect(html).toContain("max-md:h-auto");
    expect(html).toContain("max-md:py-3");
    expect(html).not.toContain("size-[var(--side-menu-tile-size)]");
  });

  test("default shape keeps the 6px row radius", () => {
    const html = renderCollapsedItem({ label: "Pinned" });
    expect(html).toContain("rounded-[6px]");
    expect(html).not.toContain("rounded-full");
  });

  test("an expanded row ignores the circle, which would draw a pill", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Pinned",
            shape: "tile",
          }),
        ),
      ),
    );
    // Expanded, the row spans the rail's full width: rounding it fully would
    // be a 198px pill, not the 30px circle the prop asks for.
    expect(html).not.toContain("rounded-full");
    expect(html).toContain("rounded-[6px]");
  });
});

describe("SideMenu.Item indicator overlay", () => {
  test("renders the indicator inside the collapsed tile", () => {
    const html = renderCollapsedItem({
      label: "Pinned",
      indicator: createElement("span", { "data-slot": "dot" }),
    });
    expect(html).toContain('data-slot="dot"');
  });

  test("an expanded row drops it, carrying status through badge instead", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Pinned",
            indicator: createElement("span", { "data-slot": "dot" }),
          }),
        ),
      ),
    );
    expect(html).not.toContain('data-slot="dot"');
  });
});

describe("SideMenu.Item disabled", () => {
  test("uses aria-disabled and never the native attribute", () => {
    const html = renderCollapsedItem({
      label: "Pinned",
      tooltip: "No conversations",
      disabled: true,
    });
    /* The load-bearing one. A collapsed row is its own tooltip trigger, and a
       natively disabled control dispatches no pointer events, so the native
       attribute would make the tooltip explaining *why* the row is inert the
       one thing a user could not reach. `pointer-events-none` would do the
       same thing by another route. */
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("pointer-events-none");
  });

  test("drops the row from the tab order and mutes its icon", () => {
    const html = renderCollapsedItem({ label: "Pinned", disabled: true });
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("text-[color:var(--content-disabled)]");
  });

  test("keeps its slot and its hover target, dropping only the hover surface", () => {
    const html = renderCollapsedItem({ label: "Pinned", disabled: true });
    // Still a 30px row in the column, so an empty section doesn't collapse
    // the rail's rhythm; just no hover fill and no pointer affordance.
    expect(html).toContain("h-[30px]");
    expect(html).toContain("cursor-default");
    /* The enabled rules are absent rather than countered, same as the tile
       geometry: no `hover:bg-transparent` out-specifying a hover fill that
       was emitted anyway, and no `cursor-default` racing a `cursor-pointer`. */
    expect(html).not.toContain("hover:bg-[var(--surface-hover)]");
    expect(html).not.toContain("hover:bg-transparent");
    expect(html).not.toContain("cursor-pointer");
  });

  test("an enabled row keeps its hover surface", () => {
    const html = renderCollapsedItem({ label: "Pinned" });
    expect(html).toContain("hover:bg-[var(--surface-hover)]");
    expect(html).not.toContain("hover:bg-transparent");
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).not.toContain('tabindex="-1"');
  });
});

describe("SideMenu.Item collapsed accessible name", () => {
  test("a styled-tooltip row is still named, having no visible label", () => {
    const html = renderCollapsedItem({
      label: "Pinned",
      showCollapsedTooltip: true,
    });
    // The label isn't rendered and the icon is aria-hidden, so without this
    // the row reaches assistive tech as an unnamed button. The native `title`
    // that names the plain collapsed row is dropped on this path.
    expect(html).toContain('aria-label="Pinned"');
  });

  test("a custom tooltip names the row by its label, not the tooltip text", () => {
    const html = renderCollapsedItem({
      label: "Pinned",
      tooltip: "No conversations",
      disabled: true,
    });
    // The rail's empty sections rely on this split: the hint explains the
    // empty state while the name stays the section's.
    expect(html).toContain('aria-label="Pinned"');
  });

  test("an expanded row is named by its visible label alone", () => {
    const html = renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Primary" },
        createElement(
          SideMenu.Body,
          { key: "body" },
          createElement(SideMenu.Item, {
            key: "i",
            icon: Globe,
            label: "Pinned",
          }),
        ),
      ),
    );
    expect(html).not.toContain('aria-label="Pinned"');
    expect(html).toContain(">Pinned<");
  });
});

describe("useSideMenuCollapsed", () => {
  /* Reports what a slot's own trigger has to render as. Exercised through a
     real `SideMenu` rather than a stubbed context, because the value a caller
     needs is the one the menu actually publishes. */
  function Probe() {
    return createElement("span", null, String(useSideMenuCollapsed()));
  }

  function probeInside(props: {
    variant?: "rail" | "overlay";
    collapsed?: boolean;
  }): string {
    return renderToStaticMarkup(
      createElement(
        SideMenu,
        { ariaLabel: "Navigation", ...props },
        createElement(SideMenu.Footer, null, createElement(Probe, null)),
      ),
    );
  }

  test("true inside a collapsed rail", () => {
    expect(probeInside({ variant: "rail", collapsed: true })).toContain("true");
  });

  test("false inside an expanded rail", () => {
    expect(probeInside({ variant: "rail", collapsed: false })).toContain(
      "false",
    );
  });

  /* The overlay ignores `collapsed` and always shows labels, so a slot must
     not reduce its trigger to a tile there even when the flag is set. */
  test("false on the overlay even when collapsed is set", () => {
    expect(probeInside({ variant: "overlay", collapsed: true })).toContain(
      "false",
    );
  });

  /* Rendered outside any `SideMenu`, which is what a consumer mounted in
     isolation (a test, a story of the trigger alone) does. The default context
     answers rather than throwing, so such a caller gets the expanded form. */
  test("false with no SideMenu above it", () => {
    expect(renderToStaticMarkup(createElement(Probe, null))).toContain("false");
  });
});
