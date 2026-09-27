/**
 * `CsvPreview` owns the decode and the parse; the table it hands the result to
 * is covered by `tabular-grid.test.tsx`, so these cases stay on the wiring
 * between the two and on the failure the decode can hit.
 *
 * `TableVirtuoso` decides what to render from the viewport it measures, and a
 * headless DOM reports none, so the grid falls back to the seeded initial
 * count. That is the same path a server render takes, and it is enough to
 * assert the table's contents.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { CsvPreview } from "@/domains/chat/components/local-file/preview/csv-preview";

function csvBlob(text: string): Blob {
  return new Blob([text], { type: "text/csv" });
}

afterEach(() => {
  cleanup();
});

describe("CsvPreview", () => {
  test("decodes the blob and renders its header row and cells", async () => {
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
    expect(screen.getByText("2 rows x 2 columns")).toBeTruthy();
  });

  test("a headerless file counts every record as a row", async () => {
    render(<CsvPreview blob={csvBlob("1,2\n3,4\n")} filename="rows.csv" />);

    await waitFor(() =>
      expect(screen.getByText("2 rows x 2 columns")).toBeTruthy(),
    );
    expect(screen.queryAllByRole("columnheader").length).toBe(0);
  });

  test("a delimiter other than a comma is sniffed before the grid sees it", async () => {
    render(
      <CsvPreview
        blob={csvBlob("name;count\nalpha;1\n")}
        filename="rows.csv"
      />,
    );

    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
    expect(
      screen.getAllByRole("columnheader").map((cell) => cell.textContent),
    ).toEqual(["name", "count"]);
  });

  test("a blob that cannot be decoded shows the failure state", async () => {
    const unreadable = {
      text: () => Promise.reject(new Error("read failed")),
    } as unknown as Blob;

    render(<CsvPreview blob={unreadable} filename="rows.csv" />);

    await waitFor(() =>
      expect(screen.getByText("Can't preview this file")).toBeTruthy(),
    );
    expect(screen.getByText("rows.csv")).toBeTruthy();
  });
});
