/**
 * What matters about this icon is its shape: one path rather than lucide's
 * two, and still a lucide icon underneath.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PlusIcon } from "@/domains/chat/components/plus-icon";

describe("PlusIcon", () => {
  test("draws both strokes in a single path", () => {
    const html = renderToStaticMarkup(<PlusIcon />);

    // One shape, so there is no boundary between two strokes for one to land
    // over the other along. A path per stroke restores that boundary.
    expect(html.match(/<path/g)?.length).toBe(1);

    // Both subpaths present, so it is still a plus and not half of one.
    expect(html).toContain('d="M5 12h14M12 5v14"');
  });

  test("is a lucide icon, not a hand-drawn one", () => {
    const html = renderToStaticMarkup(<PlusIcon />);

    // Lucide's own wrapper renders it, so the class it stamps is present and
    // every attribute below comes from lucide's defaults rather than being
    // restated here, where they would drift.
    expect(html).toContain('class="lucide lucide-plus"');
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
