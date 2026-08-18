/**
 * Tests for the resizable-pane separator's rendered markup.
 *
 * Renders to static markup via `react-dom/server` and asserts on the emitted
 * HTML, matching the rest of this package. The sizing arithmetic behind the
 * handle is covered in `hooks/use-resizable-pane.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PaneResizeHandle } from "./pane-resize-handle";
import { ResizablePanel } from "./resizable-panel";
import { cn } from "../utils/cn";

function handleMarkup(html: string): string {
  const match = html.match(/<div[^>]*role="separator"[^>]*>/);
  if (!match) {
    throw new Error(`no separator in markup: ${html.slice(0, 400)}`);
  }
  return match[0];
}

describe("PaneResizeHandle", () => {
  const baseProps = {
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-label": "Resize panels",
    "aria-controls": "pane-1",
    "aria-valuenow": 300,
    "aria-valuemin": 100,
    "aria-valuemax": 700,
    tabIndex: 0 as const,
    onPointerDown: () => {},
    onPointerMove: () => {},
    onPointerUp: () => {},
    onPointerCancel: () => {},
    onKeyDown: () => {},
  };

  test("renders a focusable separator that reports its position", () => {
    // A separator is a widget role only when it is focusable. Without
    // tabindex it is a decorative divider that no keyboard can reach, which
    // is the promise this component exists to keep.
    const markup = handleMarkup(
      renderToStaticMarkup(createElement(PaneResizeHandle, baseProps)),
    );
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-valuenow="300"');
    expect(markup).toContain('aria-valuemin="100"');
    expect(markup).toContain('aria-valuemax="700"');
    expect(markup).toContain('aria-label="Resize panels"');
    expect(markup).toContain('aria-controls="pane-1"');
    expect(markup).toContain('aria-orientation="vertical"');
  });

  test("a caller's className cannot drop the focus ring or the cursor", () => {
    const markup = handleMarkup(
      renderToStaticMarkup(
        createElement(PaneResizeHandle, {
          ...baseProps,
          className: "absolute right-0 w-2",
        }),
      ),
    );
    expect(markup).toContain("cursor-col-resize");
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain("absolute");
  });
});

describe("ResizablePanel", () => {
  test("the separator points at the pane it sizes", () => {
    const html = renderToStaticMarkup(
      createElement(ResizablePanel, {
        left: createElement("div", null, "left"),
        right: createElement("div", null, "right"),
        defaultRightWidth: 400,
        minRightWidth: 300,
        minLeftWidth: 300,
      }),
    );
    const controls = handleMarkup(html).match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    // The id must exist on the rendered pane; a separator pointing at nothing
    // is the same broken promise as one with no tabindex.
    expect(html).toContain(`id="${controls}"`);
  });

  test("announces the pane's starting width", () => {
    const markup = handleMarkup(
      renderToStaticMarkup(
        createElement(ResizablePanel, {
          left: createElement("div"),
          right: createElement("div"),
          defaultRightWidth: 480,
          minRightWidth: 400,
        }),
      ),
    );
    expect(markup).toContain('aria-valuenow="480"');
    expect(markup).toContain('aria-valuemin="400"');
  });
});

describe("class-merge ordering for the drag-time transition", () => {
  test("a conflicting transition class is dropped unless it comes last", () => {
    // `cn` is twMerge(clsx(...)), which keeps the last class in a conflicting
    // group. A drag-time `transition-none` placed before the rail's own
    // `transition-[width,padding]` is silently removed, and the edge then
    // eases behind the cursor for the whole drag instead of tracking it.
    const rail = "transition-[width,padding] duration-[150ms] ease-in-out";
    expect(cn("flex", "transition-none", rail)).not.toContain(
      "transition-none",
    );
    expect(cn("flex", rail, "transition-none")).toContain("transition-none");
  });
});
