/**
 * Tests for the SegmentControl primitive.
 *
 * No DOM environment — mirroring `button.test.tsx`, we verify behavior through
 * two angles:
 *   1. `renderToStaticMarkup` — asserts the HTML the component emits, including
 *      the track/segment radii shared by both modes.
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

// The outer track uses a strict 8px radius (`rounded-md`: this repo's token
// scale maps md to 8px in tokens.css) and the inner segments a strict 6px
// radius, identical in icon-only and text modes. These tests pin that shared
// geometry, so any per-mode radius special-casing fails here.
describe("SegmentControl geometry (normalized radii)", () => {
  test("icon-only container uses the shared 8px track radius, not an enlarged one", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={iconItems}
        value="light"
        onChange={() => {}}
        iconOnly
        ariaLabel="Theme"
      />,
    );
    const container = containerClassName(html);
    expect(container).toContain("rounded-md");
    expect(container).not.toContain("rounded-[10px]");
    expect(container).not.toContain("rounded-lg");
  });

  test("icon-only segments use the shared 6px radius and px-2 padding", () => {
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
      expect(cls).toContain("rounded-[6px]");
      expect(cls).not.toContain("rounded-lg");
      expect(cls).toContain("px-2");
    }
  });

  test("text-mode container shares the same radius and spans full width", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={textItems}
        value="light"
        onChange={() => {}}
        ariaLabel="Theme"
      />,
    );
    const container = containerClassName(html);
    expect(container).toContain("rounded-md");
    expect(container).toContain("w-full");
    expect(container).not.toContain("rounded-[10px]");
    expect(container).not.toContain("rounded-lg");
  });

  test("text-mode segments keep flex-1 and px-3, sized by fixed height rather than py-1.5", () => {
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
      expect(cls).toContain("rounded-[6px]");
      // Single-line segments are height-sized (see the size describe below);
      // py-1.5 appears only when a sublabel switches the segment to h-auto.
      expect(cls).not.toContain("py-1.5");
    }
  });
});

describe("SegmentControl size", () => {
  test("defaults to the 28px segment height", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={textItems}
        value="light"
        onChange={() => {}}
        ariaLabel="Theme"
      />,
    );
    for (const cls of radioClassNames(html)) {
      expect(cls).toContain("h-7");
      expect(cls).not.toContain("h-6");
    }
  });

  test("sm shrinks the segments to 24px, and grows them back for touch", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={textItems}
        value="light"
        onChange={() => {}}
        ariaLabel="Theme"
        size="sm"
      />,
    );
    for (const cls of radioClassNames(html)) {
      expect(cls).toContain("h-6");
      expect(cls).not.toContain("h-7");
      // 24px is under a comfortable touch target, so it grows below `md`.
      expect(cls).toContain("max-md:h-9");
    }
  });

  // Sublabels need height to follow content, so they win over the size map
  // rather than being clipped by a fixed height.
  test("sublabels override the size in either mode", () => {
    const items: SegmentControlItem<ThemeValue>[] = [
      { value: "light", label: "Light", sublabel: "Always" },
      { value: "dark", label: "Dark", sublabel: "Always" },
    ];
    const html = renderToStaticMarkup(
      <SegmentControl
        items={items}
        value="light"
        onChange={() => {}}
        ariaLabel="Theme"
        size="sm"
      />,
    );
    for (const cls of radioClassNames(html)) {
      expect(cls).toContain("h-auto");
      expect(cls).not.toContain("h-6");
    }
  });
});

describe("SegmentControl sublabels", () => {
  const sublabelItems: SegmentControlItem<ThemeValue>[] = [
    { value: "light", label: "Light", sublabel: "bright and clear" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
  ];

  test("renders the sublabel under the label when provided", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={sublabelItems}
        value="light"
        onChange={() => {}}
        ariaLabel="Theme"
      />,
    );
    expect(html).toContain("bright and clear");
    expect(html).toContain("flex-col");
  });

  test("items without a sublabel keep the single-line rendering", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={textItems}
        value="light"
        onChange={() => {}}
        ariaLabel="Theme"
      />,
    );
    expect(html).not.toContain("flex-col");
  });

  test("iconOnly mode ignores sublabels", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={sublabelItems.map((item, i) => ({
          ...item,
          icon: iconItems[i]!.icon,
        }))}
        value="light"
        onChange={() => {}}
        iconOnly
        ariaLabel="Theme"
      />,
    );
    expect(html).not.toContain("bright and clear");
  });
});

describe("SegmentControl unset value", () => {
  test("null value renders no active segment", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={textItems}
        value={null}
        onChange={() => {}}
        ariaLabel="Theme"
      />,
    );
    expect(html).not.toContain('aria-checked="true"');
  });

  test("null value keeps a roving tab stop on the first enabled segment", () => {
    const html = renderToStaticMarkup(
      <SegmentControl
        items={[
          { value: "light" as const, label: "Light", disabled: true },
          { value: "dark" as const, label: "Dark" },
          { value: "system" as const, label: "System" },
        ]}
        value={null}
        onChange={() => {}}
        ariaLabel="Theme"
      />,
    );
    const tabIndexes = [...html.matchAll(/tabindex="(-?\d)"/g)].map(
      (match) => match[1],
    );
    expect(tabIndexes).toEqual(["-1", "0", "-1"]);
  });

  test("clicking any segment from the unset state selects it", () => {
    expect(resolveSegmentSelection(textItems, null, "dark")).toBe("dark");
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
