import { describe, expect, test } from "bun:test";

import {
  buildDeselectionDescription,
  describeTableRow,
  formatDeselectionList,
} from "../daemon/conversation-surfaces.js";
import type { SurfaceData, SurfaceType } from "../daemon/message-protocol.js";
import type {
  ListSurfaceData,
  TableColumn,
  TableRow,
  TableSurfaceData,
} from "../daemon/message-types/surfaces.js";

const cols: TableColumn[] = [
  { id: "sender", label: "Sender" },
  { id: "count", label: "Emails Found" },
];

function makeTableState(rows: TableRow[]): {
  surfaceType: SurfaceType;
  data: SurfaceData;
} {
  const data: TableSurfaceData = {
    columns: cols,
    rows,
    selectionMode: "multiple",
  };
  return { surfaceType: "table", data };
}

function makeListState(items: ListSurfaceData["items"]): {
  surfaceType: SurfaceType;
  data: SurfaceData;
} {
  const data: ListSurfaceData = { items, selectionMode: "multiple" };
  return { surfaceType: "list", data };
}

describe("describeTableRow", () => {
  test("extracts plain string cell value", () => {
    const row: TableRow = {
      id: "r1",
      cells: { sender: "Acme Corp", count: "5" },
    };
    expect(describeTableRow(row, cols)).toBe("Acme Corp");
  });

  test("extracts text from rich cell value object", () => {
    const row: TableRow = {
      id: "r2",
      cells: {
        sender: {
          text: "Newsletter Inc",
          icon: "envelope",
          iconColor: "muted",
        },
        count: "12",
      },
    };
    expect(describeTableRow(row, cols)).toBe("Newsletter Inc");
  });

  test("falls back to row id when columns are empty", () => {
    const row: TableRow = { id: "r3", cells: { sender: "X" } };
    expect(describeTableRow(row, [])).toBe("r3");
  });

  test("falls back to row id when first column cell is missing", () => {
    const row: TableRow = { id: "r4", cells: { count: "3" } };
    expect(describeTableRow(row, cols)).toBe("r4");
  });
});

describe("formatDeselectionList", () => {
  test("formats labels as bullet list", () => {
    const result = formatDeselectionList(["Alpha", "Beta"]);
    expect(result).toBe("- Alpha\n- Beta");
  });

  test("returns empty string for empty list", () => {
    expect(formatDeselectionList([])).toBe("");
  });

  test("truncates at 20 items with suffix", () => {
    const labels = Array.from({ length: 25 }, (_, i) => `Item ${i + 1}`);
    const result = formatDeselectionList(labels);
    const lines = result.split("\n");
    expect(lines).toHaveLength(21); // 20 items + 1 "(and 5 more)"
    expect(lines[20]).toBe("(and 5 more)");
    expect(lines[0]).toBe("- Item 1");
    expect(lines[19]).toBe("- Item 20");
  });
});

describe("buildDeselectionDescription", () => {
  test("table with deselections includes deselected labels", () => {
    const state = makeTableState([
      { id: "r1", cells: { sender: "Keep Me", count: "2" } },
      { id: "r2", cells: { sender: "Archive Me", count: "10" } },
      { id: "r3", cells: { sender: "Also Keep", count: "1" } },
    ]);
    const result = buildDeselectionDescription("table", state, ["r2"]);
    expect(result).toContain("Deselected items (user chose NOT to include):");
    expect(result).toContain("- Keep Me");
    expect(result).toContain("- Also Keep");
    expect(result).not.toContain("Archive Me");
  });

  test("list with deselections includes deselected titles", () => {
    const state = makeListState([
      { id: "i1", title: "Important" },
      { id: "i2", title: "Spam Newsletter" },
      { id: "i3", title: "Another Important" },
    ]);
    const result = buildDeselectionDescription("list", state, ["i2"]);
    expect(result).toContain("Deselected items (user chose NOT to include):");
    expect(result).toContain("- Important");
    expect(result).toContain("- Another Important");
    expect(result).not.toContain("Spam Newsletter");
  });

  test("all selected — no deselection text", () => {
    const state = makeTableState([
      { id: "r1", cells: { sender: "A", count: "1" } },
      { id: "r2", cells: { sender: "B", count: "2" } },
    ]);
    const result = buildDeselectionDescription("table", state, ["r1", "r2"]);
    expect(result).toBe("");
  });

  test("non-selectable rows excluded from deselection list", () => {
    const state = makeTableState([
      {
        id: "r1",
        cells: { sender: "Selectable", count: "3" },
        selectable: true,
      },
      {
        id: "r2",
        cells: { sender: "Not Selectable", count: "5" },
        selectable: false,
      },
      { id: "r3", cells: { sender: "Also Selectable", count: "1" } },
    ]);
    // Only r1 is selected — r2 is non-selectable so should not appear as deselected, r3 should
    const result = buildDeselectionDescription("table", state, ["r1"]);
    expect(result).toContain("- Also Selectable");
    expect(result).not.toContain("Not Selectable");
  });

  test("rich cell values (objects with text field) handled correctly", () => {
    const state = makeTableState([
      {
        id: "r1",
        cells: {
          sender: {
            text: "Elevate (invoices)",
            icon: "doc",
            iconColor: "muted",
          },
          count: "7",
        },
      },
      {
        id: "r2",
        cells: {
          sender: {
            text: "Promo Blast",
            icon: "megaphone",
            iconColor: "warning",
          },
          count: "20",
        },
      },
    ]);
    const result = buildDeselectionDescription("table", state, ["r2"]);
    expect(result).toContain("- Elevate (invoices)");
    expect(result).not.toContain("Promo Blast");
  });

  test('truncation at 20 items with "(and N more)" suffix', () => {
    const rows: TableRow[] = Array.from({ length: 25 }, (_, i) => ({
      id: `r${i}`,
      cells: { sender: `Sender ${i}`, count: "1" },
    }));
    const state = makeTableState(rows);
    // Select none — all 25 are deselected
    const result = buildDeselectionDescription("table", state, []);
    expect(result).toContain("(and 5 more)");
    // Should have exactly 20 bullet items
    const bullets = result.match(/^- /gm);
    expect(bullets).toHaveLength(20);
  });

  test("returns empty for undefined surface state", () => {
    expect(buildDeselectionDescription("table", undefined, ["r1"])).toBe("");
  });

  test("returns empty for mismatched surface type", () => {
    const state = makeTableState([
      { id: "r1", cells: { sender: "A", count: "1" } },
    ]);
    // Pass 'list' type but table state
    expect(buildDeselectionDescription("list", state, [])).toBe("");
  });
});
