import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor } from "storybook/test";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

const meta: Meta<typeof Table> = {
  title: "Components/Table",
  component: Table,
  argTypes: {
    density: {
      control: "inline-radio",
      options: ["compact", "default", "relaxed"],
    },
    inset: { control: "boolean" },
    dividers: { control: "inline-radio", options: ["rows", "header", "none"] },
    layout: { control: "inline-radio", options: ["auto", "fixed"] },
    containerProps: { control: false },
  },
  args: { density: "default", inset: true, dividers: "rows", layout: "auto" },
};

export default meta;

type Story = StoryObj<typeof Table>;

const WEEKS = [
  { week: "2026-08-03", users: "12,840", change: "+3.1%" },
  { week: "2026-08-10", users: "13,217", change: "+2.9%" },
  { week: "2026-08-17", users: "13,655", change: "+3.3%" },
  { week: "2026-08-24", users: "14,102", change: "+3.3%" },
];

/** A readout: headers, rows, and a caption below the table. */
export const Default: Story = {
  render: (args) => (
    <Table {...args}>
      <TableCaption>Weekly active users, last four weeks.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Week</TableHead>
          <TableHead align="end">Users</TableHead>
          <TableHead align="end">Change</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {WEEKS.map((row) => (
          <TableRow key={row.week}>
            <TableCell>{row.week}</TableCell>
            <TableCell align="end">{row.users}</TableCell>
            <TableCell align="end">{row.change}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
  // A table that fits fades nothing and adds no tab stop.
  play: async ({ canvasElement }) => {
    const container = tableContainer(canvasElement);
    await expect(container.getAttribute("role")).toBeNull();
    await expect(container.hasAttribute("tabindex")).toBe(false);
    await expect(container.style.maskImage).toBe("");
  },
};

/**
 * Rows a person picks from. `interactive` gives each row a hand cursor and a
 * hover surface; `selected` marks the chosen one. The consumer owns the state.
 */
export const SelectableRows: Story = {
  parameters: { controls: { disable: true } },
  render: (args) => (
    <Table {...args}>
      <TableHeader>
        <TableRow>
          <TableHead>Week</TableHead>
          <TableHead>Users</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {WEEKS.map((row, index) => (
          <TableRow key={row.week} interactive selected={index === 1}>
            <TableCell>{row.week}</TableCell>
            <TableCell>{row.users}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

/**
 * Wider than its host: the container scrolls sideways, the page does not. It
 * fades the side with columns past it, and is a named, focusable region so a
 * keyboard can scroll to them.
 */
export const Overflowing: Story = {
  parameters: { controls: { disable: true } },
  render: (args) => (
    <div style={{ width: 320 }}>
      <Table {...args} containerProps={{ "aria-label": "Weekly metrics" }}>
        <TableHeader>
          <TableRow>
            {["Week", "Users", "Sessions", "Retention", "Revenue"].map(
              (label) => (
                <TableHead key={label} className="whitespace-nowrap">
                  {label}
                </TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {WEEKS.map((row) => (
            <TableRow key={row.week}>
              <TableCell className="whitespace-nowrap">{row.week}</TableCell>
              <TableCell>{row.users}</TableCell>
              <TableCell>41,208</TableCell>
              <TableCell>62%</TableCell>
              <TableCell>$18,340</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const container = tableContainer(canvasElement);
    await waitFor(() => expect(container.getAttribute("role")).toBe("region"));
    await expect(container.tabIndex).toBe(0);
    await expect(container.getAttribute("aria-label")).toBe("Weekly metrics");
    // At rest only the end fades: the columns past it are the hidden ones.
    await expect(fadedSides(container)).toEqual({ start: false, end: true });

    container.scrollLeft = container.scrollWidth;
    await waitFor(() =>
      expect(fadedSides(container)).toEqual({ start: true, end: false }),
    );
  },
};

/**
 * Flush cells for a table that sits under a heading: the first column starts
 * at the text edge, rules only under the header, relaxed rows. The layout
 * settings tables use.
 */
export const FlushUnderHeading: Story = {
  args: { inset: false, dividers: "header", density: "relaxed" },
  render: (args) => (
    <Table {...args}>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Aug 1, 2026</TableCell>
          <TableCell>$240.00</TableCell>
          <TableCell>Paid</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Jul 1, 2026</TableCell>
          <TableCell>$240.00</TableCell>
          <TableCell>Paid</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};

/** Fixed layout: columns take their declared widths whatever their content. */
export const FixedColumns: Story = {
  args: { layout: "fixed", inset: false },
  render: (args) => (
    <Table {...args}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[50%]">Snapshot</TableHead>
          <TableHead className="w-[20%]">Type</TableHead>
          <TableHead className="w-[30%]">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="truncate">
            assistant-2026-08-24T02-00-00Z-full-with-a-very-long-name
          </TableCell>
          <TableCell>Full</TableCell>
          <TableCell>Aug 24, 2026</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};

function tableContainer(canvasElement: HTMLElement): HTMLElement {
  const container = canvasElement.querySelector<HTMLElement>(
    '[data-slot="table-container"]',
  );
  if (!container) {
    throw new Error("The story renders no table container.");
  }
  return container;
}

/** Which sides of the container's mask are transparent, in reading order. */
function fadedSides(container: HTMLElement): { start: boolean; end: boolean } {
  const mask = container.style.maskImage;
  return {
    start: mask.startsWith("linear-gradient(to right, transparent"),
    end: mask.endsWith("transparent)"),
  };
}
