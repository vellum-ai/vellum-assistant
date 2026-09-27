/**
 * `TableVirtuoso` decides what to render from the viewport it measures, and a
 * headless DOM reports none, so the grid falls back to the seeded initial
 * count. That is the same path a server render takes, and it is enough to
 * assert the table's contents.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { TabularGrid } from "@/domains/chat/components/local-file/preview/tabular-grid";

afterEach(() => {
  cleanup();
});

describe("TabularGrid", () => {
  test("renders the header row and the cells under it", async () => {
    render(
      <TabularGrid
        headers={["name", "count"]}
        rows={[
          ["alpha", "1"],
          ["beta", "2"],
        ]}
        truncated={false}
      />,
    );

    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());

    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((cell) => cell.textContent)).toEqual(["name", "count"]);
    expect(screen.getByText("beta")).toBeTruthy();
  });

  test("the footer counts the rows and columns by default", async () => {
    render(
      <TabularGrid
        headers={["name", "count"]}
        rows={[
          ["alpha", "1"],
          ["beta", "2"],
        ]}
        truncated={false}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("2 rows x 2 columns")).toBeTruthy(),
    );
  });

  test("a truncated grid says so in the default footer", async () => {
    render(
      <TabularGrid
        headers={["name", "count"]}
        rows={[["alpha", "1"]]}
        truncated={true}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("1 row x 2 columns (truncated)")).toBeTruthy(),
    );
  });

  test("a caller-supplied summary replaces the default footer", async () => {
    render(
      <TabularGrid
        headers={["name", "count"]}
        rows={[["alpha", "1"]]}
        truncated={false}
        summary="Sheet 1 of 3"
      />,
    );

    await waitFor(() => expect(screen.getByText("Sheet 1 of 3")).toBeTruthy());
    expect(screen.queryByText("1 row x 2 columns")).toBeNull();
  });

  test("a null summary draws no footer at all", async () => {
    render(
      <TabularGrid
        headers={["name", "count"]}
        rows={[["alpha", "1"]]}
        truncated={false}
        summary={null}
      />,
    );

    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
    expect(screen.queryByText(/columns/)).toBeNull();
  });

  test("a full cell is readable through its title attribute", async () => {
    render(
      <TabularGrid
        headers={["name", "count"]}
        rows={[["a very long cell value indeed", "1"]]}
        truncated={false}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("a very long cell value indeed")).toBeTruthy(),
    );
    const cell = screen
      .getByText("a very long cell value indeed")
      .closest("td");
    expect(cell?.getAttribute("title")).toBe("a very long cell value indeed");
  });

  test("an empty cell keeps its row at text height", async () => {
    render(
      <TabularGrid
        headers={["name", "count"]}
        rows={[
          ["alpha", "1"],
          ["", ""],
          ["beta", "2"],
        ]}
        truncated={false}
      />,
    );

    await waitFor(() => expect(screen.getByText("beta")).toBeTruthy());

    const blank = screen
      .getAllByRole("row")
      .find((row) => row.getAttribute("data-index") === "1");
    const cells = [...(blank?.querySelectorAll("td") ?? [])];

    expect(cells.length).toBe(2);
    for (const cell of cells) {
      expect(cell.textContent).toBe("\u00a0");
      expect(cell.getAttribute("title")).toBe("");
    }
  });

  test("an empty grid shows the caller's empty label instead of a table", async () => {
    render(
      <TabularGrid
        headers={null}
        rows={[]}
        truncated={false}
        emptyLabel="This sheet is empty"
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("This sheet is empty")).toBeTruthy(),
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("an empty grid falls back to the file copy with no label", async () => {
    render(<TabularGrid headers={null} rows={[]} truncated={false} />);

    await waitFor(() =>
      expect(screen.getByText("This file is empty")).toBeTruthy(),
    );
  });
});
