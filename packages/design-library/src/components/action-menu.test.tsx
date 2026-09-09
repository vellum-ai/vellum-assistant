import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ActionMenu, actionMenuDestructiveClasses } from "./action-menu";

const presentations = ["anchored", "sheet"] as const;

describe("ActionMenu destructive tone", () => {
  test("paints the label from the negative token in both presentations", () => {
    for (const presentation of presentations) {
      expect(actionMenuDestructiveClasses[presentation]).toContain(
        "text-[var(--system-negative-strong)]",
      );
    }
  });

  test("hands the glyph the row's colour rather than one of its own", () => {
    // A colour of its own is how the two came apart: the highlighted row moved
    // its label to `--system-negative-hover` while the icon stayed on
    // `-strong`, so the text darkened and the glyph did not.
    expect(actionMenuDestructiveClasses.anchored).toContain(
      "[&_[data-slot=menu-item-icon]]:text-inherit",
    );
    expect(actionMenuDestructiveClasses.sheet).toContain(
      "[--panel-item-icon-fg:var(--system-negative-strong)]",
    );
    for (const presentation of presentations) {
      expect(actionMenuDestructiveClasses[presentation]).not.toContain(
        "svg]:text-[var(--system-negative-strong)]",
      );
    }
  });

  test("keeps the highlighted label on the negative hover token", () => {
    expect(actionMenuDestructiveClasses.anchored).toContain(
      "data-[highlighted]:text-[var(--system-negative-hover)]",
    );
  });
});

/**
 * `Root` is a context provider in both presentations, so a row renders without
 * the surface around it. The sheet's row is the one that renders outside a
 * portal, which is what static markup can reach; the anchored row's copy of
 * this is asserted where both surfaces are driven end to end.
 */
function renderSheetItem(selected: boolean): string {
  return renderToStaticMarkup(
    <ActionMenu.Root presentation="sheet">
      <ActionMenu.Item
        label="Opus"
        description="Most capable"
        selected={selected}
      />
    </ActionMenu.Root>,
  );
}

describe("ActionMenu selected item", () => {
  test("marks the chosen row current and draws the check", () => {
    const html = renderSheetItem(true);
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("lucide-check");
  });

  test("names the row from its label, the mark being decorative", () => {
    // The label alone, so a supporting line and the check both stay out of
    // what the row announces.
    expect(renderSheetItem(true)).toContain('aria-label="Opus"');
  });

  test("leaves an unchosen row unmarked", () => {
    const html = renderSheetItem(false);
    expect(html).not.toContain("aria-current");
    expect(html).not.toContain("lucide-check");
  });
});
