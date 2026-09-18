import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { classifyHorizontalDragSurface } from "@/hooks/use-edge-swipe";

import { TableSurface } from "./table-surface";

afterEach(cleanup);

test("a structured table reserves horizontal drags only when its scrollport overflows", () => {
  const { getByRole } = render(
    <TableSurface
      surface={{
        surfaceId: "surface-1",
        surfaceType: "table",
        data: {
          columns: [{ id: "name", label: "Name" }],
          rows: [{ id: "row-1", cells: { name: "Example item" } }],
        },
      }}
      onAction={() => {}}
    />,
  );
  const cell = getByRole("cell");
  const scrollport = getByRole("table").parentElement!;
  expect(scrollport.hasAttribute("data-owns-horizontal-scroll")).toBe(true);
  Object.defineProperties(scrollport, {
    clientWidth: { value: 300 },
    scrollWidth: { configurable: true, value: 900 },
  });
  expect(classifyHorizontalDragSurface(cell)).toBe("scroll");
  Object.defineProperty(scrollport, "scrollWidth", { value: 300 });
  expect(classifyHorizontalDragSurface(cell)).toBe("none");
});

test("names its scroll area after the surface's title, then its caption", () => {
  const data = {
    columns: [{ id: "name", label: "Name" }],
    rows: [{ id: "row-1", cells: { name: "Example item" } }],
  };
  const scrollLabel = (title: string | undefined, caption?: string) => {
    const { getByRole, unmount } = render(
      <TableSurface
        surface={{
          surfaceId: "surface-1",
          surfaceType: "table",
          title,
          data: { ...data, caption },
        }}
        onAction={() => {}}
      />,
    );
    const label = getByRole("table").parentElement?.getAttribute("aria-label");
    unmount();
    return label;
  };

  // Focusable while it scrolls sideways, so it always carries a name.
  expect(scrollLabel("Weekly metrics", "Last four weeks")).toBe(
    "Weekly metrics",
  );
  expect(scrollLabel(undefined, "Last four weeks")).toBe("Last four weeks");
  expect(scrollLabel(undefined)).toBe("Table");
  // A blank title or caption names nothing, so the next one is used.
  expect(scrollLabel("  ", "Last four weeks")).toBe("Last four weeks");
  expect(scrollLabel("", " ")).toBe("Table");
});
