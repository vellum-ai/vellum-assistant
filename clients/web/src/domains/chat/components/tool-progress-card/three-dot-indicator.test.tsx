/**
 * Tests for `ThreeDotIndicator`.
 *
 * Verifies the indicator renders three evenly-sized dots that share the
 * `busy-indicator` class (so they match the single-dot `BusyIndicator`
 * pulse and inherit its reduced-motion override) with a 150ms stagger,
 * and that `dotSize`/`gap` scale the indicator for tighter contexts like
 * the avatar badge. Uses happy-dom via the bun:test preload configured in
 * `web/bunfig.toml`, so inline `style` values are readable on the rendered
 * DOM nodes.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";

afterEach(() => {
  cleanup();
});

function getDots(container: HTMLElement): HTMLElement[] {
  const wrapper = container.firstElementChild as HTMLElement | null;
  if (!wrapper) {
    throw new Error("ThreeDotIndicator did not render a wrapper element");
  }
  return Array.from(wrapper.children) as HTMLElement[];
}

describe("ThreeDotIndicator", () => {
  test("renders 3 evenly-sized 8px dots", () => {
    const { container } = render(<ThreeDotIndicator />);
    const dots = getDots(container);
    expect(dots).toHaveLength(3);
    for (const dot of dots) {
      expect(dot.style.width).toBe("8px");
      expect(dot.style.height).toBe("8px");
    }
  });

  test("each dot is staggered by 150ms via animationDelay", () => {
    const { container } = render(<ThreeDotIndicator />);
    const dots = getDots(container);
    expect(dots).toHaveLength(3);
    expect(dots[0]!.style.animationDelay).toBe("0ms");
    expect(dots[1]!.style.animationDelay).toBe("150ms");
    expect(dots[2]!.style.animationDelay).toBe("300ms");
  });

  test("each dot carries the shared busy-indicator class (matches BusyIndicator + reduced-motion)", () => {
    const { container } = render(<ThreeDotIndicator />);
    const dots = getDots(container);
    // The `busy-indicator` class supplies the `busy-pulse` animation and
    // is the selector the `prefers-reduced-motion` override targets, so
    // carrying it is what lets the dots stop animating under reduced motion.
    for (const dot of dots) {
      expect(dot.className).toContain("busy-indicator");
    }
  });

  test("dotSize and gap scale the indicator for tighter contexts", () => {
    /**
     * Tests that the avatar badge can shrink the indicator to fit a small
     * pill via the `dotSize` and `gap` props.
     */

    // GIVEN a down-scaled indicator (avatar-badge sizing)
    const { container } = render(<ThreeDotIndicator dotSize={5} gap={2} />);

    // WHEN we read the wrapper and its dots
    const wrapper = container.firstElementChild as HTMLElement;
    const dots = getDots(container);

    // THEN every dot lays out at the requested diameter
    expect(dots).toHaveLength(3);
    for (const dot of dots) {
      expect(dot.style.width).toBe("5px");
      expect(dot.style.height).toBe("5px");
    }

    // AND the wrapper uses the requested gap
    expect(wrapper.style.gap).toBe("2px");
  });

  test("wrapper accepts a custom className and defaults to 3px gap", () => {
    const { container } = render(<ThreeDotIndicator className="ml-2" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("ml-2");
    // Base classes are still applied.
    expect(wrapper.className).toContain("inline-flex");
    expect(wrapper.style.gap).toBe("3px");
  });
});
