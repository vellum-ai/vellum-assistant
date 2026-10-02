/**
 * Tests for the StatSquare tile, through the HTML it emits.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StatSquare } from "./stat-square";

describe("StatSquare", () => {
  test("a tile with its value shows the value and carries it as a tooltip", () => {
    const html = renderToStaticMarkup(
      <StatSquare icon={<svg data-testid="icon" />} value="$12" label="Cost" />,
    );
    expect(html).toContain(">$12</span>");
    expect(html).toContain('title="$12"');
    expect(html).toContain("Cost");
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain("animate-spin");
  });

  test("a loading tile keeps its icon and label, holds the value's line, and is busy", () => {
    const html = renderToStaticMarkup(
      <StatSquare
        loading
        icon={<svg data-testid="icon" />}
        value="$12"
        label="Cost"
      />,
    );
    expect(html).toContain('data-testid="icon"');
    expect(html).toContain("Cost");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("$12");
  });
});
