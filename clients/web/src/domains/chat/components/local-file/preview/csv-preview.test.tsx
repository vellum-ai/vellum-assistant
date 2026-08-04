import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { CsvPreview } from "@/domains/chat/components/local-file/preview/csv-preview";

/**
 * `TableVirtuoso` decides what to render from the viewport it measures, and a
 * headless DOM reports none, so the grid falls back to the seeded initial
 * count. That is the same path a server render takes, and it is enough to
 * assert the table's contents.
 */
function csvBlob(text: string): Blob {
  return new Blob([text], { type: "text/csv" });
}

afterEach(() => {
  cleanup();
});

describe("CsvPreview", () => {
  test("renders the header row and the cells under it", async () => {
    render(
      <CsvPreview
        blob={csvBlob("name,count\nalpha,1\nbeta,2\n")}
        filename="rows.csv"
      />,
    );

    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());

    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((cell) => cell.textContent)).toEqual(["name", "count"]);
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  test("a full cell is readable through its title attribute", async () => {
    render(
      <CsvPreview
        blob={csvBlob("name,count\na very long cell value indeed,1\n")}
        filename="rows.csv"
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

  test("the footer counts the rows and columns", async () => {
    render(
      <CsvPreview
        blob={csvBlob("name,count\nalpha,1\nbeta,2\n")}
        filename="rows.csv"
      />,
    );

    await waitFor(() => expect(screen.getByText("2 rows x 2 columns")).toBeTruthy());
  });

  test("a headerless file counts every record as a row", async () => {
    render(<CsvPreview blob={csvBlob("1,2\n3,4\n")} filename="rows.csv" />);

    await waitFor(() => expect(screen.getByText("2 rows x 2 columns")).toBeTruthy());
    expect(screen.queryAllByRole("columnheader").length).toBe(0);
  });

  test("a capped file says it was truncated", async () => {
    const lines: string[] = ["name,count"];
    for (let i = 0; i < 5010; i += 1) {
      lines.push(`row-${i},${i}`);
    }

    render(
      <CsvPreview blob={csvBlob(lines.join("\n"))} filename="rows.csv" />,
    );

    await waitFor(() =>
      expect(
        screen.getByText("4999 rows x 2 columns (truncated)"),
      ).toBeTruthy(),
    );
  });

  test("an empty file says so instead of rendering a grid", async () => {
    render(<CsvPreview blob={csvBlob("")} filename="rows.csv" />);

    await waitFor(() => expect(screen.getByText("This file is empty")).toBeTruthy());
    expect(screen.queryByRole("table")).toBeNull();
  });
});
