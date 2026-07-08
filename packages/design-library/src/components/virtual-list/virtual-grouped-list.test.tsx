/**
 * Tests for the VirtualGroupedList primitive.
 *
 * As with VirtualList, `react-virtuoso` renders its items/headers via layout
 * effects that do not run under `react-dom/server`, so item and group-header
 * content never appears in static markup of the full component. The collapse
 * and flattening logic is therefore unit tested through the pure helpers
 * (`buildGroupModel`, `isGroupCollapsed`) and the default header / non-sticky
 * group wrapper are rendered directly.
 */

import { describe, expect, test } from "bun:test";
import { Globe } from "lucide-react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  VirtualGroupedList,
  DefaultGroupHeader,
  NonStickyGroup,
  StickyGroup,
  buildGroupModel,
  resolveGroupedItemKey,
  isGroupCollapsed,
  type VirtualGroupedListProps,
  type VirtualListGroup,
} from "./virtual-grouped-list";

const GROUPS: VirtualListGroup<string>[] = [
  { key: "g1", label: "Group One", items: ["a", "b"] },
  {
    key: "g2",
    label: "Group Two",
    items: ["c", "d", "e"],
    collapsible: true,
    defaultCollapsed: true,
  },
];

describe("isGroupCollapsed", () => {
  test("a non-collapsible group is never collapsed", () => {
    const group: VirtualListGroup<string> = {
      key: "g",
      label: "G",
      items: [],
      defaultCollapsed: true,
    };
    expect(isGroupCollapsed(group, {})).toBe(false);
  });

  test("a collapsible group honours its defaultCollapsed seed", () => {
    const collapsed: VirtualListGroup<string> = {
      key: "g",
      label: "G",
      items: [],
      collapsible: true,
      defaultCollapsed: true,
    };
    const expanded: VirtualListGroup<string> = {
      key: "g",
      label: "G",
      items: [],
      collapsible: true,
    };
    expect(isGroupCollapsed(collapsed, {})).toBe(true);
    expect(isGroupCollapsed(expanded, {})).toBe(false);
  });

  test("an explicit override wins over the seed", () => {
    const group: VirtualListGroup<string> = {
      key: "g",
      label: "G",
      items: [],
      collapsible: true,
      defaultCollapsed: true,
    };
    expect(isGroupCollapsed(group, { g: false })).toBe(false);
  });
});

describe("buildGroupModel", () => {
  test("flattens groups into parallel arrays and group counts", () => {
    const model = buildGroupModel(
      [
        { key: "g1", label: "One", items: ["a", "b"] },
        { key: "g2", label: "Two", items: ["c"] },
      ],
      {},
    );
    expect(model.groupCounts).toEqual([2, 1]);
    expect(model.flatItems).toEqual(["a", "b", "c"]);
    expect(model.flatGroupKeys).toEqual(["g1", "g1", "g2"]);
  });

  test("a collapsed group contributes a 0 count and none of its items", () => {
    // g2 is collapsible + defaultCollapsed.
    const model = buildGroupModel(GROUPS, {});
    expect(model.groupCounts).toEqual([2, 0]);
    expect(model.flatItems).toEqual(["a", "b"]);
    expect(model.flatGroupKeys).toEqual(["g1", "g1"]);
  });

  test("expanding a default-collapsed group via override restores its items", () => {
    const model = buildGroupModel(GROUPS, { g2: false });
    expect(model.groupCounts).toEqual([2, 3]);
    expect(model.flatItems).toEqual(["a", "b", "c", "d", "e"]);
    expect(model.flatGroupKeys).toEqual(["g1", "g1", "g2", "g2", "g2"]);
  });

  test("combined arrays index by virtuoso's header-inclusive row index", () => {
    // g2 collapsed → combined rows [H(g1), a, b, H(g2)]; every group keeps a
    // header row, collapsed or not.
    const collapsed = buildGroupModel(GROUPS, {});
    expect(collapsed.combinedItems).toEqual([undefined, "a", "b", undefined]);
    expect(collapsed.combinedItemOnlyIndex).toEqual([-1, 0, 1, -1]);

    // g2 expanded → combined rows [H(g1), a, b, H(g2), c, d, e].
    const expanded = buildGroupModel(GROUPS, { g2: false });
    expect(expanded.combinedItems).toEqual([
      undefined,
      "a",
      "b",
      undefined,
      "c",
      "d",
      "e",
    ]);
    expect(expanded.combinedItemOnlyIndex).toEqual([-1, 0, 1, -1, 2, 3, 4]);
  });
});

describe("resolveGroupedItemKey", () => {
  test("item rows defer to computeItemKey with an item-only index", () => {
    const model = buildGroupModel(
      [
        { key: "g1", label: "G1", items: [{ id: 10 }, { id: 11 }] },
        { key: "g2", label: "G2", items: [{ id: 12 }] },
      ],
      {},
    );
    const computeItemKey = (_index: number, item: { id: number }) => item.id;
    // combined rows: [H(g1), {10}, {11}, H(g2), {12}]
    expect(resolveGroupedItemKey(model, 1, computeItemKey)).toBe(10);
    expect(resolveGroupedItemKey(model, 2, computeItemKey)).toBe(11);
    expect(resolveGroupedItemKey(model, 4, computeItemKey)).toBe(12);
  });

  test("header rows get a namespaced key that can't collide with numeric item keys", () => {
    const model = buildGroupModel(
      [
        { key: "g1", label: "G1", items: [{ id: 0 }, { id: 1 }] },
        { key: "g2", label: "G2", items: [{ id: 2 }] },
      ],
      {},
    );
    const computeItemKey = (_index: number, item: { id: number }) => item.id;
    // Header rows at combined index 0 and 3 would, with a bare-number fallback,
    // collide with the item keyed 0 (combined index 1). They must not.
    expect(resolveGroupedItemKey(model, 0, computeItemKey)).toBe(
      "__virtual-grouped-list-header-0",
    );
    expect(resolveGroupedItemKey(model, 3, computeItemKey)).toBe(
      "__virtual-grouped-list-header-3",
    );

    // Every key across all combined rows is unique — no duplicate React keys.
    const keys = [0, 1, 2, 3, 4].map((i) =>
      resolveGroupedItemKey(model, i, computeItemKey),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("DefaultGroupHeader", () => {
  function render(group: VirtualListGroup<string>, collapsed = false): string {
    return renderToStaticMarkup(
      createElement(DefaultGroupHeader<string>, {
        group,
        collapsed,
        toggle: () => {},
      }),
    );
  }

  test("renders the label with a data-slot", () => {
    const html = render({ key: "g", label: "Recent", items: [] });
    expect(html).toContain('data-slot="virtual-grouped-list-header"');
    expect(html).toContain("Recent");
  });

  test("a non-collapsible header renders as a div, not a button", () => {
    expect(render({ key: "g", label: "Recent", items: [] })).not.toContain(
      "<button",
    );
  });

  test("a collapsible header renders a toggle button reflecting expanded state", () => {
    const expanded = render(
      { key: "g", label: "Recent", items: [], collapsible: true },
      false,
    );
    expect(expanded).toContain("<button");
    expect(expanded).toContain('aria-expanded="true"');

    const collapsed = render(
      { key: "g", label: "Recent", items: [], collapsible: true },
      true,
    );
    expect(collapsed).toContain('aria-expanded="false"');
    // Chevron rotates to point right when the group is collapsed.
    expect(collapsed).toContain("-rotate-90");
  });

  test("renders a provided icon", () => {
    const html = render({ key: "g", label: "Recent", items: [], icon: Globe });
    expect(html).toContain("<svg");
  });
});

describe("group wrappers", () => {
  const groupProps = {
    "data-index": 3,
    "data-known-size": 42,
    role: "presentation",
    style: { position: "sticky", top: 0, zIndex: 2 },
    context: { internal: true },
    children: createElement("span", null, "Header"),
  };

  test("NonStickyGroup carries data-slot, forwards attributes, strips context, forces static positioning", () => {
    const html = renderToStaticMarkup(createElement(NonStickyGroup, groupProps));
    expect(html).toContain('data-slot="virtual-grouped-list-group"');
    // Sticky positioning is neutralized so the header scrolls with its items.
    expect(html).toContain("position:static");
    // Virtuoso's measurement/index attributes (and any role/aria) survive.
    expect(html).toContain('data-index="3"');
    expect(html).toContain('data-known-size="42"');
    expect(html).toContain('role="presentation"');
    expect(html).toContain("Header");
    // `context` must never reach the DOM node.
    expect(html).not.toContain("context");
  });

  test("StickyGroup carries data-slot and preserves virtuoso's sticky positioning", () => {
    const html = renderToStaticMarkup(createElement(StickyGroup, groupProps));
    expect(html).toContain('data-slot="virtual-grouped-list-group"');
    expect(html).toContain('data-index="3"');
    // Virtuoso's sticky style is left intact.
    expect(html).toContain("position:sticky");
    expect(html).not.toContain("position:static");
    expect(html).not.toContain("context");
  });
});

describe("VirtualGroupedList rendering", () => {
  function render(
    props: Partial<VirtualGroupedListProps<string>> = {},
  ): string {
    return renderToStaticMarkup(
      createElement(VirtualGroupedList<string>, {
        groups: GROUPS,
        itemContent: (_index: number, item: string): ReactNode =>
          createElement("div", null, item),
        ...props,
      }),
    );
  }

  test("renders a root carrying data-slot='virtual-grouped-list'", () => {
    expect(render()).toContain('data-slot="virtual-grouped-list"');
  });

  test("merges className over the surface-base background", () => {
    const html = render({ className: "w-64" });
    expect(html).toContain("bg-[var(--surface-base)]");
    expect(html).toContain("w-64");
  });

  test("renders with sticky headers disabled without throwing", () => {
    expect(render({ stickyHeaders: false })).toContain(
      'data-slot="virtual-grouped-list"',
    );
  });
});
