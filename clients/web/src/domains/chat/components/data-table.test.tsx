/**
 * `DataTable` draws exactly the columns and rows it is given: headers in
 * column order, a cell per column per row, a rich cell's icon beside its text,
 * a selection column only when a selection is passed, and a markdown copy of
 * the same table.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  DataTable,
  tableToMarkdown,
  type DataTableColumn,
  type DataTableRow,
} from "./data-table";

const COLUMNS: DataTableColumn[] = [
  { id: "week", label: "Week" },
  { id: "users", label: "Users" },
];

const ROWS: DataTableRow[] = [
  { id: "r1", cells: { week: "2026-08-03", users: "12840" } },
  {
    id: "r2",
    cells: {
      week: "2026-08-10",
      users: { text: "13217", icon: <span data-testid="up-icon" /> },
    },
  },
];

afterEach(cleanup);

describe("DataTable", () => {
  test("renders headers in column order and a cell per column per row", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} />);
    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Week", "Users"]);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("12840")).toBeDefined();
  });

  test("a rich cell shows its icon beside its text", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByTestId("up-icon")).toBeDefined();
    expect(screen.getByText("13217")).toBeDefined();
  });

  test("a missing cell renders empty rather than throwing", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[{ id: "r", cells: { week: "w" } }]}
      />,
    );
    const cells = screen.getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["w", ""]);
  });

  test("a selection adds a leading column and reports the clicked row", () => {
    const toggled: string[] = [];
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        selection={{
          mode: "multiple",
          selectedIds: ["r1"],
          onToggle: (id) => toggled.push(id),
        }}
      />,
    );
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    fireEvent.click(screen.getByText("2026-08-10"));
    expect(toggled).toEqual(["r2"]);
  });

  test("without a selection there is no leading column and rows are inert", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} />);
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getAllByRole("row")[1]?.className).not.toContain(
      "cursor-pointer",
    );
  });

  test("renderCell draws every cell's text, plain and rich alike", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        renderCell={(text) => <em data-testid="cell-text">{text}</em>}
      />,
    );
    expect(screen.getAllByTestId("cell-text")).toHaveLength(4);
  });

  test("the caption renders under the table when given", () => {
    render(
      <DataTable columns={COLUMNS} rows={ROWS} caption="Weekly actives" />,
    );
    expect(screen.getByText("Weekly actives")).toBeDefined();
  });
});

describe("tableToMarkdown", () => {
  test("writes a GFM table with pipes and newlines escaped", () => {
    expect(
      tableToMarkdown(COLUMNS, [
        { id: "r", cells: { week: "a|b", users: { text: "line\nbreak" } } },
      ]),
    ).toBe("| Week | Users |\n| --- | --- |\n| a\\|b | line break |");
  });
});
