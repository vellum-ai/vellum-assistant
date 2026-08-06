/**
 * Tests for SpecChip: verifies the compact label text renders and that the
 * passed Lucide icon renders as an <svg>. Uses `renderToStaticMarkup` for a
 * single-pass, DOM-free render.
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
});
