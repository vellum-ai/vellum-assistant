/**
 * `TableVirtuoso` decides what to render from the viewport it measures, and a
 * headless DOM reports none, so the grid falls back to the seeded initial
 * count. That is the same path a server render takes, and it is enough to
 * assert the table's contents.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  WorkbookGrid,
  XlsxPreview,
} from "@/domains/chat/components/local-file/preview/xlsx-preview";
import {
  grid,
  sheet,
} from "@/domains/chat/components/local-file/preview/xlsx-preview.test-helper";
import type { WorkbookSheet } from "@/domains/chat/components/local-file/preview/xlsx";
import { workbookBlob } from "@/domains/chat/components/local-file/preview/xlsx.test-helper";

const EXPENSES = sheet(
  "Expenses",
  grid(
    [
      ["Rent", "1200"],
      ["Coffee", "48"],
    ],
    ["item", "amount"],
  ),
);
const INCOME = sheet(
  "Income",
  grid([["Salary", "4000"]], ["source", "amount"]),
);
const NOTES = sheet("Notes", grid([["Renew the lease"]]));

afterEach(() => {
  cleanup();
});

describe("WorkbookGrid", () => {
  test("a single-sheet workbook shows the grid with no switcher", async () => {
    render(<WorkbookGrid sheets={[EXPENSES]} />);

    await waitFor(() => expect(screen.getByText("Rent")).toBeTruthy());
    expect(screen.queryAllByRole("tab").length).toBe(0);
  });

  test("every sheet gets a tab and the first one opens", async () => {
    render(<WorkbookGrid sheets={[EXPENSES, INCOME, NOTES]} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Expenses",
      "Income",
      "Notes",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(screen.getByText("Rent")).toBeTruthy());
  });

  test("picking a tab opens that sheet and the footer names it", async () => {
    const user = userEvent.setup();
    render(<WorkbookGrid sheets={[EXPENSES, INCOME, NOTES]} />);

    await waitFor(() =>
      expect(screen.getByText("Expenses: 2 rows x 2 columns")).toBeTruthy(),
    );

    await user.click(screen.getAllByRole("tab")[1]);

    await waitFor(() => expect(screen.getByText("Salary")).toBeTruthy());
    expect(screen.getByText("Income: 1 row x 2 columns")).toBeTruthy();
    expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByText("Rent")).toBeNull();
  });

  test("an empty sheet says so and leaves the other tabs usable", async () => {
    const user = userEvent.setup();
    const empty = sheet("Blank", grid([]));
    render(<WorkbookGrid sheets={[empty, INCOME]} />);

    await waitFor(() =>
      expect(screen.getByText("This sheet is empty")).toBeTruthy(),
    );
    expect(screen.queryByRole("table")).toBeNull();

    await user.click(screen.getAllByRole("tab")[1]);

    await waitFor(() => expect(screen.getByText("Salary")).toBeTruthy());
  });

  test("a tab's id and the panel it controls carry no whitespace", async () => {
    render(
      <WorkbookGrid sheets={[sheet("Q1 Budget", grid([["kept"]])), INCOME]} />,
    );

    await waitFor(() => expect(screen.getByText("kept")).toBeTruthy());

    const [tab] = screen.getAllByRole("tab");
    expect(tab.textContent).toBe("Q1 Budget");
    expect(tab.getAttribute("id")).not.toMatch(/\s/);
    expect(tab.getAttribute("aria-controls")).not.toMatch(/\s/);
  });

  test("sheets sharing a name get a tab each and switch independently", async () => {
    const user = userEvent.setup();
    render(
      <WorkbookGrid
        sheets={[
          sheet("Sheet", grid([["first"]])),
          sheet("Sheet", grid([["second"]])),
        ]}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(2);
    await waitFor(() => expect(screen.getByText("first")).toBeTruthy());

    await user.click(tabs[1]);

    await waitFor(() => expect(screen.getByText("second")).toBeTruthy());
    expect(screen.queryByText("first")).toBeNull();
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  });

  test("a sheet that cannot be read fails inside its own panel", async () => {
    const user = userEvent.setup();
    const broken: WorkbookSheet = {
      name: "Broken",
      read: () => Promise.reject(new Error("sheet part is missing")),
    };
    render(<WorkbookGrid sheets={[broken, INCOME]} />);

    await waitFor(() =>
      expect(screen.getByText("This sheet could not be read")).toBeTruthy(),
    );
    expect(screen.getAllByRole("tab").length).toBe(2);

    await user.click(screen.getAllByRole("tab")[1]);

    await waitFor(() => expect(screen.getByText("Salary")).toBeTruthy());
    expect(screen.queryByText("This sheet could not be read")).toBeNull();
  });
});

describe("XlsxPreview", () => {
  test("reads a workbook blob into a tab per sheet", async () => {
    const blob = await workbookBlob({
      sheets: [
        {
          name: "Q1",
          rows: [
            ["item", "amount"],
            ["Rent", 1200],
          ],
        },
        {
          name: "Q2",
          rows: [
            ["item", "amount"],
            ["Rent", 1250],
          ],
        },
      ],
    });

    render(<XlsxPreview blob={blob} filename="budget.xlsx" />);

    expect(screen.getByLabelText("Loading preview")).toBeTruthy();

    await waitFor(() => expect(screen.getAllByRole("tab").length).toBe(2));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Q1",
      "Q2",
    ]);
    await waitFor(() => expect(screen.getByText("Rent")).toBeTruthy());
  });

  test("a workbook with no sheets shows the failure state", async () => {
    const blob = await workbookBlob({ sheets: [] });

    render(<XlsxPreview blob={blob} filename="empty.xlsx" />);

    await waitFor(() =>
      expect(screen.getByText("Can't preview this file")).toBeTruthy(),
    );
    expect(screen.getByText("empty.xlsx")).toBeTruthy();
  });

  test("a blob that is not a workbook shows the failure state", async () => {
    render(
      <XlsxPreview
        blob={new Blob(["this is not a zip container"])}
        filename="budget.xlsx"
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Can't preview this file")).toBeTruthy(),
    );
    expect(screen.getByText("budget.xlsx")).toBeTruthy();
  });
});
