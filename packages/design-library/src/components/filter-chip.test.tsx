/**
 * Tests for the FilterChip primitive.
 *
 * No DOM environment, mirroring `segment-control.test.tsx`: the markup
 * `renderToStaticMarkup` emits is the contract, since selection state is the
 * caller's and the chip only draws what it is handed.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FilterChip } from "./filter-chip";

describe("FilterChip", () => {
  test("renders a pressed toggle button with its label and count", () => {
    const html = renderToStaticMarkup(
      <FilterChip selected count={9}>
        Finance
      </FilterChip>,
    );

    expect(html).toContain('data-slot="filter-chip"');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-slot="filter-chip-label">Finance</span>');
    expect(html).toContain("9</span>");
  });

  test("omits the count slot when no count is given", () => {
    const html = renderToStaticMarkup(
      <FilterChip selected={false}>Meetings</FilterChip>,
    );

    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('data-slot="filter-chip-count"');
  });

  test("draws selected and unselected chips in different styles", () => {
    const selected = renderToStaticMarkup(
      <FilterChip selected>Sales</FilterChip>,
    );
    const unselected = renderToStaticMarkup(
      <FilterChip selected={false}>Sales</FilterChip>,
    );

    expect(selected).toContain("bg-[var(--primary-base)]");
    expect(unselected).not.toContain("bg-[var(--primary-base)]");
    expect(unselected).toContain("bg-[var(--surface-lift)]");
  });

  test("forwards button props and merges className", () => {
    const html = renderToStaticMarkup(
      <FilterChip selected={false} disabled className="ml-2">
        Sales
      </FilterChip>,
    );

    expect(html).toContain("disabled");
    expect(html).toContain("ml-2");
  });
});
