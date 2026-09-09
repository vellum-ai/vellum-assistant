import { describe, expect, test } from "bun:test";

import { actionMenuDestructiveClasses } from "./action-menu";

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
