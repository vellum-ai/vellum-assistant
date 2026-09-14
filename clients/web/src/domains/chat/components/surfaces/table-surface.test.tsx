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
