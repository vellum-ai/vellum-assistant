/**
 * Tests for the GoToNewest affordance.
 *
 * GoToNewest is plain React with no DOM measurement, so it renders fully
 * under `react-dom/server` and its behaviour is asserted on the emitted HTML.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GoToNewest, type GoToNewestProps } from "./go-to-newest";

function render(props: Partial<GoToNewestProps> = {}): string {
  return renderToStaticMarkup(
    createElement(GoToNewest, {
      visible: true,
      onClick: () => {},
      ...props,
    }),
  );
}

describe("GoToNewest", () => {
  test("renders a button carrying data-slot and the label", () => {
    const html = render();
    expect(html).toContain('data-slot="go-to-newest"');
    expect(html).toContain("<button");
    expect(html).toContain("Go to Newest");
  });

  test("is visible and focusable when visible", () => {
    const html = render({ visible: true });
    expect(html).toContain('aria-hidden="false"');
    expect(html).not.toContain("opacity-0");
    expect(html).not.toContain('tabindex="-1"');
  });

  test("fades out and leaves the tab order when not visible", () => {
    const html = render({ visible: false });
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("opacity-0");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain('tabindex="-1"');
  });

  test("hides the streaming dots by default", () => {
    expect(render()).not.toContain("animate-go-to-newest-dot");
  });

  test("shows three streaming dots, animated only under motion-safe", () => {
    const html = render({ isStreaming: true });
    const dotCount = html.split("motion-safe:animate-go-to-newest-dot").length - 1;
    expect(dotCount).toBe(3);
  });

  test("appends a custom className", () => {
    const html = render({ className: "absolute bottom-4" });
    expect(html).toContain("absolute");
    expect(html).toContain("bottom-4");
  });
});
