/**
 * The read-only grid the document drawer shows for a `.csv` or `.tsv` file:
 * a sticky header when the first record reads as one, virtualized data rows,
 * and a footer with the row and column count. The grid fills the height its
 * frame gives it, so the decorator mounts it in a fixed-size box the way the
 * drawer body does. The stories cover a short file, a wide one that scrolls
 * sideways inside that box, a file with no header row, an empty file, and a
 * blob that cannot be decoded.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { CsvPreview } from "./csv-preview";

function csvBlob(text: string): Blob {
  return new Blob([text], { type: "text/csv" });
}

/** A blob whose bytes are not text, so the decode step rejects. */
class UndecodableBlob extends Blob {
  override text(): Promise<string> {
    return Promise.reject(new Error("The file is not valid text."));
  }
}

const PANTRY_CSV = [
  "item,quantity,unit,restock_below",
  "Rolled oats,2,kg,1",
  "Black beans,6,cans,3",
  "Olive oil,1,bottle,1",
  "Basmati rice,4,kg,2",
  "Peanut butter,2,jars,1",
  "Canned tomatoes,8,cans,4",
].join("\n");

const WIDE_COLUMN_COUNT = 26;
const WIDE_ROW_COUNT = 80;

/** One reading per station per hour, wide enough to overflow the frame. */
const STATION_READINGS_CSV = [
  [
    "hour",
    ...Array.from(
      { length: WIDE_COLUMN_COUNT - 1 },
      (_, index) => `station_${String(index + 1).padStart(2, "0")}_temp_c`,
    ),
  ].join(","),
  ...Array.from({ length: WIDE_ROW_COUNT }, (_, row) =>
    [
      `2026-09-${String(1 + Math.floor(row / 24)).padStart(2, "0")} ${String(row % 24).padStart(2, "0")}:00`,
      ...Array.from({ length: WIDE_COLUMN_COUNT - 1 }, (_, column) =>
        (14 + ((row * 7 + column * 3) % 90) / 10).toFixed(1),
      ),
    ].join(","),
  ),
].join("\n");

/** All text, so no row qualifies as a header and every record is data. */
const ROSTER_CSV = [
  "Ada,Tuesday,morning",
  "Bram,Tuesday,afternoon",
  "Cleo,Thursday,morning",
  "Dev,Friday,afternoon",
].join("\n");

const meta = {
  title: "Chat/CsvPreview",
  component: CsvPreview,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    blob: { control: false },
  },
  decorators: [
    (Story) => (
      <div className="flex h-[480px] w-[720px] flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-overlay)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CsvPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A short file with a header row: the whole grid fits without scrolling. */
export const Small: Story = {
  args: {
    blob: csvBlob(PANTRY_CSV),
    filename: "pantry.csv",
  },
};

/**
 * More columns than the frame can show and more rows than one screen: the
 * grid scrolls sideways under its sticky header and virtualizes the rows.
 */
export const Wide: Story = {
  args: {
    blob: csvBlob(STATION_READINGS_CSV),
    filename: "station-readings.csv",
  },
};

/** A file whose first record is data, so the grid renders without a header. */
export const WithoutHeader: Story = {
  args: {
    blob: csvBlob(ROSTER_CSV),
    filename: "roster.csv",
  },
};

/** Nothing but whitespace decodes to an empty grid, which says so. */
export const EmptyFile: Story = {
  args: {
    blob: csvBlob("\n"),
    filename: "empty.csv",
  },
};

/** The decode step rejected, so the drawer's compact failure state shows. */
export const DecodeFailure: Story = {
  args: {
    blob: new UndecodableBlob([new Uint8Array([0xff, 0xfe, 0x00])]),
    filename: "export.csv",
  },
};
