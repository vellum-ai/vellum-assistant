/**
 * The point of this icon is its shape, not its appearance: one path rather
 * than lucide's two, so the rasterizer sees a single shape and cannot part
 * the strokes where they cross.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PlusIcon } from "@/components/icons/plus-icon";

describe("PlusIcon", () => {
  test("draws both strokes in a single path", () => {
    const html = renderToStaticMarkup(<PlusIcon />);

    // One shape, so there is no boundary between two strokes for the device's
    // one-pixel gap to open along. Splitting this back into a path per stroke
    // restores the structure that artifact needs.
    expect(html.match(/<path/g)?.length).toBe(1);

    // Both subpaths present, so it is still a plus and not half of one.
    expect(html).toContain('d="M5 12h14M12 5v14"');
  });

  test("keeps lucide's stroke geometry so it sits beside lucide glyphs", () => {
    const html = renderToStaticMarkup(<PlusIcon />);

    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-linecap="round"');
    expect(html).toContain('fill="none"');
  });

  test("takes a caller's stroke width", () => {
    expect(renderToStaticMarkup(<PlusIcon strokeWidth={1.5} />)).toContain(
      'stroke-width="1.5"',
    );
  });
});
