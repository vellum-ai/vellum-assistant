/**
 * The structured table a tool hands the transcript: columns, rows keyed by
 * column id, an optional caption under the grid, and an optional selection
 * mode that turns rows into choices the surface's actions submit. The stories
 * cover a plain readout with a caption, a multi-select table with one row
 * already chosen and one that cannot be chosen, and cells that carry an icon
 * and a tone beside their text.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { TranscriptColumn } from "@/domains/chat/transcript/transcript-column";
import type { Surface } from "@/domains/chat/types/types";

import { TableSurface } from "./table-surface";

function makeTableSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "table-surface",
    surfaceType: "table",
    data: { columns: [], rows: [] },
    ...overrides,
  };
}

const meta = {
  title: "Chat/Surfaces/Table",
  component: TableSurface,
  parameters: {
    layout: "padded",
  },
  args: {
    onAction: fn(),
  },
  decorators: [
    (Story) => (
      <TranscriptColumn>
        <Story />
      </TranscriptColumn>
    ),
  ],
} satisfies Meta<typeof TableSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A read-only comparison with a fixed-width first column and a caption. */
export const Readout: Story = {
  args: {
    surface: makeTableSurface({
      title: "Weekend weather",
      data: {
        columns: [
          { id: "day", label: "Day", width: 120 },
          { id: "high", label: "High" },
          { id: "low", label: "Low" },
          { id: "outlook", label: "Outlook" },
        ],
        rows: [
          {
            id: "fri",
            cells: { day: "Friday", high: "72°", low: "58°", outlook: "Sunny" },
          },
          {
            id: "sat",
            cells: {
              day: "Saturday",
              high: "68°",
              low: "55°",
              outlook: "Partly cloudy",
            },
          },
          {
            id: "sun",
            cells: {
              day: "Sunday",
              high: "61°",
              low: "51°",
              outlook: "Showers after noon",
            },
          },
        ],
        caption: "Forecast for the city center, updated this morning.",
      },
    }),
  },
};

/**
 * Rows as choices: the first row arrives already selected, the third cannot
 * be selected at all, and the actions submit whatever is checked.
 */
export const MultipleSelection: Story = {
  args: {
    surface: makeTableSurface({
      title: "Which errands should go on Saturday?",
      data: {
        selectionMode: "multiple",
        columns: [
          { id: "errand", label: "Errand" },
          { id: "where", label: "Where" },
          { id: "time", label: "Takes" },
        ],
        rows: [
          {
            id: "groceries",
            selected: true,
            cells: {
              errand: "Groceries",
              where: "Market on 3rd",
              time: "45 min",
            },
          },
          {
            id: "library",
            cells: {
              errand: "Return library books",
              where: "Central branch",
              time: "15 min",
            },
          },
          {
            id: "dentist",
            selectable: false,
            cells: {
              errand: "Dentist (already booked)",
              where: "Elm St clinic",
              time: "1 hr",
            },
          },
          {
            id: "hardware",
            cells: {
              errand: "Pick up paint",
              where: "Hardware store",
              time: "20 min",
            },
          },
        ],
      },
      actions: [
        { id: "plan", label: "Add to Saturday", style: "primary" },
        { id: "skip", label: "Not now" },
      ],
    }),
  },
};

/** Cells with an icon and a semantic tone next to the text. */
export const RichCells: Story = {
  args: {
    surface: makeTableSurface({
      title: "Home devices",
      data: {
        columns: [
          { id: "device", label: "Device" },
          { id: "status", label: "Status" },
          { id: "checked", label: "Last check" },
        ],
        rows: [
          {
            id: "thermostat",
            cells: {
              device: "Thermostat",
              status: {
                text: "Online",
                icon: "checkmark.circle.fill",
                iconColor: "success",
              },
              checked: "2 min ago",
            },
          },
          {
            id: "doorbell",
            cells: {
              device: "Doorbell",
              status: {
                text: "Low battery",
                icon: "exclamationmark.triangle.fill",
                iconColor: "warning",
              },
              checked: "10 min ago",
            },
          },
          {
            id: "garage",
            cells: {
              device: "Garage sensor",
              status: {
                text: "Unreachable",
                icon: "xmark.circle.fill",
                iconColor: "error",
              },
              checked: "3 hr ago",
            },
          },
          {
            id: "sprinkler",
            cells: {
              device: "Sprinkler",
              status: {
                text: "Paused for winter",
                icon: "minus.circle",
                iconColor: "muted",
              },
              checked: "Yesterday",
            },
          },
        ],
      },
    }),
  },
};
