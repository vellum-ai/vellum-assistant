/**
 * Tests for the SegmentControl primitive.
 *
 * No DOM environment — mirroring `button.test.tsx`, we verify behavior through
 * two angles:
 *   1. `renderToStaticMarkup` — asserts the HTML the component emits, including
 *      the icon-only geometry that PR 1 enlarges to match the iOS mock.
 *   2. The pure `resolveSegmentSelection` helper that each segment's onClick
 *      delegates to — asserts the click→onChange decision without a renderer.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SegmentControl,
  type SegmentControlItem,
  resolveSegmentSelection,
} from "./segment-control";

type ThemeValue = "light" | "dark" | "system";

const iconItems: SegmentControlItem<ThemeValue>[] = [
  { value: "light", label: "Light", icon: <svg data-testid="icon-light" /> },
  { value: "dark", label: "Dark", icon: <svg data-testid="icon-dark" /> },
  { value: "system", label: "System", icon: <svg data-testid="icon-system" /> },
];

const textItems: SegmentControlItem<ThemeValue>[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** Extracts the `class` value of every `role="radio"` button in the markup. */
function radioClassNames(html: string): string[] {
  const matches = html.matchAll(/<button[^>]*role="radio"[^>]*>/g);
  return [...matches].map((match) => {
    const classMatch = match[0].match(/class="([^"]*)"/);
    return classMatch?.[1] ?? "";
  });
}

/** Extracts the `class` value of the `data-slot="segment-control"` container. */
function containerClassName(html: string): string {
  const match = html.match(
    /<div[^>]*data-slot="segment-control"[^>]*>/,
  )?.[0];
  return match?.match(/class="([^"]*)"/)?.[1] ?? "";
}

describe("SegmentControl icon-only geometry", () => {
  test("container uses the enlarged 10px radius", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={iconItems}
        value="light"
        onChange={() => {}}
        iconOnly
        ariaLabel="Theme"
      />,
    );
    expect(containerClassName(html)).toContain("rounded-[10px]");
  });

  test("each segment uses the enlarged radius (rounded-lg) and padding (px-2)", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={iconItems}
        value="light"
        onChange={() => {}}
        iconOnly
        ariaLabel="Theme"
      />,
    );
    const classes = radioClassNames(html);
    expect(classes).toHaveLength(iconItems.length);
    for (const cls of classes) {
      expect(cls).toContain("rounded-lg");
      expect(cls).toContain("px-2");
    }
  });
});

describe("SegmentControl text-mode (non-icon-only) geometry is unchanged", () => {
  test("container stays rounded-lg and does NOT gain the 10px radius", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={textItems}
        value="light"
        onChange={() => {}}
        ariaLabel="Theme"
      />,
    );
    const container = containerClassName(html);
    expect(container).toContain("rounded-lg");
    expect(container).not.toContain("rounded-[10px]");
  });

  test("each segment keeps flex-1, px-3 and py-1.5", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={textItems}
        value="light"
        onChange={() => {}}
        ariaLabel="Theme"
      />,
    );
    const classes = radioClassNames(html);
    expect(classes).toHaveLength(textItems.length);
    for (const cls of classes) {
      expect(cls).toContain("flex-1");
      expect(cls).toContain("px-3");
      expect(cls).toContain("py-1.5");
    }
  });
});

describe("SegmentControl selection behavior", () => {
  test("clicking a non-active segment resolves to the new value", () => {
    expect(resolveSegmentSelection(iconItems, "light", "dark")).toBe("dark");
  });

  test("clicking the active segment is a no-op", () => {
    expect(resolveSegmentSelection(iconItems, "light", "light")).toBeNull();
  });

  test("clicking a disabled segment is a no-op", () => {
    const items: SegmentControlItem<ThemeValue>[] = [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark", disabled: true },
      { value: "system", label: "System" },
    ];
    expect(resolveSegmentSelection(items, "light", "dark")).toBeNull();
  });
});
