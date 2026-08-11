import { describe, expect, test } from "bun:test";

import { PANEL_ITEM_WASH, panelItemWashStyle } from "./panel-item-tint";

describe("panelItemWashStyle", () => {
  test("mixes the colour into the lifted surface at both steps", () => {
    expect(panelItemWashStyle("#7c3aed", { rest: 14, raised: 36 })).toEqual({
      "--panel-item-bg": "color-mix(in srgb, #7c3aed 14%, var(--surface-lift))",
      "--panel-item-hover":
        "color-mix(in srgb, #7c3aed 36%, var(--surface-lift))",
      "--panel-item-active":
        "color-mix(in srgb, #7c3aed 36%, var(--surface-lift))",
    });
  });

  /* Tinted rows in the same column are washed to the same depth, so callers
     that want the standard treatment must not have to name the steps. */
  test("falls back to the standard steps", () => {
    expect(panelItemWashStyle("#118a7e")).toEqual(
      panelItemWashStyle("#118a7e", PANEL_ITEM_WASH),
    );
  });

  /* The pill's active surface has its own declaration, so a wash that set only
     the resting property would drop its tint at exactly the moment the row is
     the current page. */
  test("hover and current page land on the same raised surface", () => {
    const style = panelItemWashStyle("#118a7e");
    expect(style["--panel-item-active"]).toBe(style["--panel-item-hover"]);
  });

  /* A wash moves the surface too little to need a paired foreground, so the
     label keeps the content token every other row uses. */
  test("declares no foreground", () => {
    expect("--panel-item-fg" in panelItemWashStyle("#7c3aed")).toBe(false);
  });
});
