import { Fragment } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import { ListRow } from "./list-row";
import { Toggle } from "./toggle";

const meta: Meta<typeof ListRow> = {
  title: "Components/ListRow",
  component: ListRow,
  argTypes: {
    title: { control: "text" },
    subtitle: { control: "text" },
    showChevron: { control: "boolean" },
    selected: { control: "boolean" },
    disabled: { control: "boolean" },
  },
  args: {
    title: "hourly water reminder",
    subtitle: "Every hour · Jun 11, 2:00 PM",
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof ListRow>;

/** Right-aligned metadata cluster, styled like the Schedules cost · runs columns. */
function Usage({ cost, runs }: { cost: string; runs: string }) {
  return (
    <Fragment>
      <span className="text-body-small-default text-[var(--content-secondary)]">
        {cost}
      </span>
      <span className="text-body-small-default text-[var(--content-secondary)]">
        {runs}
      </span>
    </Fragment>
  );
}

/** Dot-separated meta line, matching the Schedules `cadence · timestamp` subtitle. */
function MetaParts({ parts }: { parts: string[] }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span className="h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--content-tertiary)]" />
          ) : null}
          <span className="truncate">{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

export const Default: Story = {};

/** Read-only row: no toggle, no chevron — e.g. an MCP registered-tool row. */
export const Readout: Story = {
  args: {
    title: "list_meetings",
    subtitle:
      "List meetings recorded by or shared with the authenticated user. Supports filtering by date range, attendee, recorder, and team.",
    trailing: (
      <span className="whitespace-nowrap text-body-small-default text-[var(--content-secondary)]">
        ~375 tok
      </span>
    ),
  },
};

/** Interactive row with a leading toggle and trailing usage, like a live schedule. */
export const WithToggleAndUsage: Story = {
  args: {
    leading: <Toggle checked onChange={() => {}} aria-label="Toggle schedule" />,
    subtitle: <MetaParts parts={["Every hour", "Jun 11, 2:00 PM"]} />,
    trailing: <Usage cost="$0.00" runs="0 runs" />,
    onClick: () => {},
  },
};

export const Selected: Story = {
  args: {
    subtitle: <MetaParts parts={["Every hour", "Jun 11, 2:00 PM"]} />,
    trailing: <Usage cost="$0.00" runs="0 runs" />,
    onClick: () => {},
    selected: true,
  },
};

export const Disabled: Story = {
  args: {
    leading: <Toggle checked={false} onChange={() => {}} aria-label="Toggle schedule" />,
    subtitle: <MetaParts parts={["Every hour", "Jun 11, 2:00 PM"]} />,
    trailing: <Usage cost="$0.00" runs="0 runs" />,
    onClick: () => {},
    disabled: true,
  },
};

/** A stack of rows demonstrating the automatic hairline dividers between siblings. */
export const DividedList: Story = {
  render: () => (
    <div>
      <ListRow
        leading={<Toggle checked onChange={() => {}} aria-label="Toggle" />}
        title="hourly water reminder"
        subtitle={<MetaParts parts={["Every hour", "Jun 11, 2:00 PM"]} />}
        trailing={<Usage cost="$0.00" runs="0 runs" />}
        onClick={() => {}}
      />
      <ListRow
        title="spacex stock fetch"
        subtitle={<MetaParts parts={["Jun 15, 3:08 PM"]} />}
        trailing={<Usage cost="$0.00" runs="0 runs" />}
        onClick={() => {}}
      />
      <ListRow
        title="drink water"
        subtitle={<MetaParts parts={["Jun 15, 9:34 AM"]} />}
        trailing={<Usage cost="$0.00" runs="0 runs" />}
        onClick={() => {}}
      />
    </div>
  ),
};
