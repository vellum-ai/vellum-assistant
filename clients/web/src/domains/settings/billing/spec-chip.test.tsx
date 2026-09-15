/**
 * Tests for SpecChip: verifies the compact label text renders, that the passed
 * Lucide icon renders as an <svg>, and that the pill holds its content width in
 * a wrapping row. Uses `renderToStaticMarkup` for a single-pass, DOM-free
 * render.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Coins } from "lucide-react";

import { SpecChip } from "./spec-chip";

describe("SpecChip", () => {
  test("renders the label text", () => {
    const markup = renderToStaticMarkup(
      <SpecChip icon={Coins} label="$25 credits" />,
    );

    expect(markup).toContain("$25 credits");
  });

  test("renders the passed icon as an svg", () => {
    const markup = renderToStaticMarkup(
      <SpecChip icon={Coins} label="$25 credits" />,
    );

    expect(markup).toContain("<svg");
  });

  test("holds its content width, capped at the row", () => {
    // `shrink-0` is what keeps a packed row from squeezing a pill narrower
    // than its label and wrapping it mid-chip; `max-w-full` is the escape
    // hatch for a label longer than the row, which wraps inside the pill
    // rather than overflowing the tile.
    const markup = renderToStaticMarkup(
      <SpecChip icon={Coins} label="$25 credits" />,
    );

    expect(markup).toContain("shrink-0");
    expect(markup).toContain("max-w-full");
  });
});
