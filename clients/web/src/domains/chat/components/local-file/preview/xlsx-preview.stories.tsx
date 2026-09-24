/**
 * The read-only view the document drawer shows for an `.xlsx` or `.xlsm`
 * workbook: the shared tabular grid, and under it, once there is more than one
 * sheet, a bar holding a tab per sheet on the left and the open sheet's row
 * and column count on the right. The grid fills the height its frame gives it,
 * so the decorator mounts it in a fixed-size box the way the drawer body does.
 *
 * The stories drive `WorkbookGrid`, the presentational half, so a sheet is
 * stated as the grid it reads to rather than as a binary workbook. They cover
 * one sheet (no bar), a few sheets, enough sheets to scroll the row sideways,
 * more sheets than the switcher mounts, names long enough to truncate, an
 * empty sheet, a capped sheet, a sheet wide enough to lose columns, a sheet
 * that cannot be read, and the mobile width.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  MAX_WORKBOOK_SHEETS,
  type SheetGrid,
  type WorkbookSheet,
} from "./xlsx";
import { WorkbookGrid } from "./xlsx-preview";
import { grid, sheet } from "./xlsx-preview.test-helper";

const EXPENSE_HEADERS = ["category", "budget", "spent", "remaining"];

/** One month of a household budget, short enough to fit without scrolling. */
function expenseGrid(month: string): SheetGrid {
  const categories = [
    ["Rent", "1800", "1800"],
    ["Groceries", "520", "487"],
    ["Transit", "140", "126"],
    ["Utilities", "210", "233"],
    [`${month} one-off`, "300", "265"],
  ];
  return grid(
    categories.map(([category, budget, spent]) => [
      category,
      budget,
      spent,
      String(Number(budget) - Number(spent)),
    ]),
    EXPENSE_HEADERS,
  );
}

/** A long sheet, so the grid virtualizes and the footer counts into the tens. */
const READINGS_GRID: SheetGrid = grid(
  Array.from({ length: 240 }, (_, index) => [
    `2026-09-${String(1 + Math.floor(index / 24)).padStart(2, "0")} ${String(index % 24).padStart(2, "0")}:00`,
    `sensor_${String((index % 6) + 1).padStart(2, "0")}`,
    (14 + ((index * 7) % 90) / 10).toFixed(1),
    String(40 + ((index * 3) % 35)),
  ]),
  ["timestamp", "sensor", "celsius", "humidity"],
);

const SINGLE_SHEET = [sheet("Budget", expenseGrid("September"))];

const THREE_SHEETS = [
  sheet("September", expenseGrid("September")),
  sheet("October", expenseGrid("October")),
  sheet("Readings", READINGS_GRID),
];

/** More tabs than the frame can show, so the row scrolls sideways. */
const MANY_SHEETS = Array.from({ length: 24 }, (_, index) =>
  sheet(
    `Week ${String(index + 1).padStart(2, "0")}`,
    expenseGrid(`Week ${index + 1}`),
  ),
);

/** Every sheet the reader builds, for a workbook that declares 25 more. */
const CAPPED_SHEETS = Array.from({ length: MAX_WORKBOOK_SHEETS }, (_, index) =>
  sheet(
    `Sheet ${String(index + 1).padStart(3, "0")}`,
    expenseGrid(`Sheet ${index + 1}`),
  ),
);

const LONG_NAME_SHEETS = [
  sheet(
    "Consolidated operating expenses by category",
    expenseGrid("September"),
  ),
  sheet("Quarterly reconciliation and carry-forward", expenseGrid("October")),
  sheet("Notes", grid([["Renew the lease"]])),
];

const EMPTY_SHEETS = [
  sheet("Blank", grid([])),
  sheet("Budget", expenseGrid("September")),
];

const TRUNCATED_SHEETS = [
  sheet("Readings", { ...READINGS_GRID, truncated: true }),
  sheet("Budget", expenseGrid("September")),
];

/**
 * A sheet whose columns run past the cap, as wide as the grid keeps them and
 * with the range the file states beside it.
 */
const WIDE_CUT_SHEETS = [
  sheet("Survey", {
    ...grid(
      Array.from({ length: 19 }, (_, row) =>
        Array.from({ length: 200 }, (_, column) => `${row + 1}-${column + 1}`),
      ),
      Array.from({ length: 200 }, (_, column) => `q${column + 1}`),
    ),
    truncated: true,
    extent: { rows: 20, columns: 300 },
  }),
];

const UNREADABLE_SHEETS: WorkbookSheet[] = [
  {
    name: "Corrupt",
    read: () => Promise.reject(new Error("The sheet part is missing.")),
  },
  sheet("Budget", expenseGrid("September")),
];

const meta = {
  title: "Chat/XlsxPreview",
  component: WorkbookGrid,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    sheets: { control: false },
  },
  decorators: [
    // `max-w-full` so the same frame narrows to a phone rather than
    // overflowing it, which is what the mobile story documents.
    (Story) => (
      <div className="flex h-[480px] w-[720px] max-w-full flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-overlay)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkbookGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One sheet needs no bar, so the grid gets the whole frame and its own footer. */
export const SingleSheet: Story = {
  args: { sheets: SINGLE_SHEET },
};

/** The common case: a tab per sheet, the first one open. */
export const ThreeSheets: Story = {
  args: { sheets: THREE_SHEETS },
};

/** Far more tabs than fit, so the row scrolls under its fading edges. */
export const ManySheets: Story = {
  args: { sheets: MANY_SHEETS },
};

/** Past the tab cap, so the row stops and a line names the sheets left out. */
export const ManySheetsCapped: Story = {
  args: { sheets: CAPPED_SHEETS, sheetCount: MAX_WORKBOOK_SHEETS + 25 },
};

/** Names longer than a tab can hold truncate, with the full name in a tooltip. */
export const LongSheetNames: Story = {
  args: { sheets: LONG_NAME_SHEETS },
};

/** Long names at phone width, where the tab row still keeps half the bar. */
export const LongSheetNamesMobile: Story = {
  args: { sheets: LONG_NAME_SHEETS },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** A sheet with nothing in it says so, and its neighbours still open. */
export const EmptySheet: Story = {
  args: { sheets: EMPTY_SHEETS },
};

/**
 * A sheet cut short by the row cap, whose file states no range to measure the
 * cut against, so the bar can only say the sheet was cut.
 */
export const TruncatedSheet: Story = {
  args: { sheets: TRUNCATED_SHEETS },
};

/**
 * A sheet wider than the column cap, whose footer names the columns the cap
 * left out rather than only saying the sheet was cut.
 */
export const WideSheetCut: Story = {
  args: { sheets: WIDE_CUT_SHEETS },
};

/** A sheet whose part cannot be read fails alone, leaving the tabs usable. */
export const UnreadableSheet: Story = {
  args: { sheets: UNREADABLE_SHEETS },
};

/** The switcher at phone width, where the tab row is the first thing to run out of room. */
export const ThreeSheetsMobile: Story = {
  args: { sheets: THREE_SHEETS },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
