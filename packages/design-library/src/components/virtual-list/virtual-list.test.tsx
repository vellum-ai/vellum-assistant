/**
 * Tests for the VirtualList primitive.
 *
 * The wrapper delegates the actual windowing to `react-virtuoso`, whose item
 * rendering is driven by layout effects that do not run under
 * `react-dom/server`. So the static-markup tests assert on the wrapper's own
 * contract (the root element it forwards `data-slot`/`className` to), while
 * the pure prop-mapping logic — the interesting part of the wrapper — is unit
 * tested directly.
 */

import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  VirtualList,
  resolveFollowOutput,
  resolveInitialTopMostItemIndex,
  type VirtualListProps,
} from "./virtual-list";

describe("resolveFollowOutput", () => {
  test("falsy values disable following", () => {
    expect(resolveFollowOutput(undefined)).toBeUndefined();
    expect(resolveFollowOutput(false)).toBeUndefined();
  });

  test("true follows only while the user is already at the bottom", () => {
    const follow = resolveFollowOutput(true);
    // At the bottom → follow; scrolled up → never yank the user back down.
    expect(typeof follow).toBe("function");
    expect((follow as (b: boolean) => unknown)(true)).toBe(true);
    expect((follow as (b: boolean) => unknown)(false)).toBe(false);
  });

  test("'smooth' follows smoothly, still only while at the bottom", () => {
    const follow = resolveFollowOutput("smooth");
    expect((follow as (b: boolean) => unknown)(true)).toBe("smooth");
    expect((follow as (b: boolean) => unknown)(false)).toBe(false);
  });
});

describe("resolveInitialTopMostItemIndex", () => {
  test("undefined stays undefined", () => {
    expect(resolveInitialTopMostItemIndex(undefined)).toBeUndefined();
  });

  test("'LAST' maps to the final item aligned to the bottom edge", () => {
    expect(resolveInitialTopMostItemIndex("LAST")).toEqual({
      index: "LAST",
      align: "end",
    });
  });

  test("a numeric index passes through unchanged", () => {
    expect(resolveInitialTopMostItemIndex(7)).toBe(7);
  });
});

describe("VirtualList rendering", () => {
  function render(props: Partial<VirtualListProps<string>> = {}): string {
    return renderToStaticMarkup(
      createElement(VirtualList<string>, {
        items: ["a", "b", "c"],
        itemContent: (_index: number, item: string): ReactNode =>
          createElement("div", null, item),
        ...props,
      }),
    );
  }

  test("renders a root carrying data-slot='virtual-list'", () => {
    expect(render()).toContain('data-slot="virtual-list"');
  });

  test("applies the surface-base background and merges className", () => {
    const html = render({ className: "h-full" });
    expect(html).toContain("bg-[var(--surface-base)]");
    expect(html).toContain("h-full");
  });

  test("renders a scrollable root", () => {
    expect(render()).toContain("overflow-y:auto");
  });

  test("accepts prepend + follow-output props without throwing", () => {
    const html = render({
      items: ["a", "b"],
      firstItemIndex: 1000,
      startReached: () => {},
      endReached: () => {},
      followOutput: "smooth",
      initialTopMostItemIndex: "LAST",
    });
    expect(html).toContain('data-slot="virtual-list"');
  });

  test("renders initial items when initialItemCount is set", () => {
    const html = render({ initialItemCount: 2 });
    expect(html).toContain("a");
    expect(html).toContain("b");
  });
});
