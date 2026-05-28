/**
 * Tests for `ThreeDotIndicator`.
 *
 * Verifies the indicator renders three evenly-sized dots that share the
 * legacy `busy-pulse` keyframe (matching the single-dot `BusyIndicator`
 * used by `ToolCallProgressCard`'s running state) with a 150ms stagger.
 * Uses happy-dom via the bun:test preload configured in `web/bunfig.toml`,
 * so inline `style` values are readable on the rendered DOM nodes.
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

  test("each dot uses the busy-pulse keyframe (matches legacy BusyIndicator)", () => {
    const { container } = render(<ThreeDotIndicator />);
    const dots = getDots(container);
    // happy-dom does not normalize the `animation` shorthand into
    // longhand `animationName`; assert against the raw style attribute
    // so the keyframe identifier is verified regardless of parser.
    for (const dot of dots) {
      expect(dot.getAttribute("style") ?? "").toContain("busy-pulse 1s");
    }
  });

  test("wrapper accepts a custom className", () => {
    const { container } = render(<ThreeDotIndicator className="ml-2" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("ml-2");
    // Base classes are still applied.
    expect(wrapper.className).toContain("inline-flex");
    expect(wrapper.className).toContain("gap-[3px]");
  });
});
