/**
 * The Schedules card from the assistant profile's bento grid, in the two
 * states its content can take.
 *
 * The bento sizes this card from the page: it starts at one Personality-row
 * of height and grows only once three schedule tiles need more. The frame
 * below stands in for that cell so both states can be read side by side at
 * the size the page gives them.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";

import type { IdentitySectionStat } from "../use-identity-section-stats";
import { buildIdentitySections } from "./identity-sections";
import { SectionCard } from "./identity-overview";

const SCHEDULES_SECTION = buildIdentitySections().find(
  (section) => section.key === "schedules",
)!;

const HOUR_MS = 3_600_000;

const POPULATED_STAT: IdentitySectionStat = {
  value: 3,
  label: "active",
  text: "3 active",
  schedules: {
    items: [
      {
        id: "sched-morning",
        name: "Morning briefing",
        cadence: "Every weekday at 8:00",
        nextRunAt: Date.now() + HOUR_MS,
      },
      {
        id: "sched-inbox",
        name: "Inbox triage",
        cadence: "Every 2 hours",
        nextRunAt: Date.now() + 2 * HOUR_MS,
      },
      {
        id: "sched-review",
        name: "Weekly review",
        cadence: "Fridays at 4:00 PM",
        nextRunAt: Date.now() + 48 * HOUR_MS,
      },
    ],
    more: 0,
  },
};

const EMPTY_STAT: IdentitySectionStat = { text: "Nothing scheduled yet" };

/** The bento cell the Schedules card occupies, at a desktop row height. */
function Cell({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid"
      style={{
        width: 280,
        gridTemplateAreas: `"schedules"`,
        gridTemplateRows: "300px",
      }}
    >
      {children}
    </div>
  );
}

function Bench({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-8 bg-[var(--surface-base)] p-10">
      {children}
    </div>
  );
}

function SchedulesCard({ stat }: { stat: IdentitySectionStat }) {
  return (
    <Cell>
      <SectionCard
        section={SCHEDULES_SECTION}
        stat={stat}
        gridArea="schedules"
        cardStyle={{ alignSelf: "start", height: "auto", minHeight: 300 }}
        hoverFill
      />
    </Cell>
  );
}

const meta = {
  title: "Intelligence/Schedules Card",
  component: SchedulesCard,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SchedulesCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * No schedules: the preview column carries dashed, dimmed outlines of two
 * example schedules, and the stat line gains an invitation. Both are
 * decoration and copy, never controls, because the card is one big link.
 */
export const Empty: Story = {
  args: { stat: EMPTY_STAT },
  render: (args) => (
    <Bench>
      <SchedulesCard {...args} />
    </Bench>
  ),
};

/** Three schedules: solid, washed tiles with a cadence and next fire time. */
export const Populated: Story = {
  args: { stat: POPULATED_STAT },
  render: (args) => (
    <Bench>
      <SchedulesCard {...args} />
    </Bench>
  ),
};

/**
 * Both together, which is how the ghosts should be judged: a glance must
 * never read the empty card as an assistant that owns two schedules.
 */
export const EmptyBesidePopulated: Story = {
  args: { stat: EMPTY_STAT },
  render: () => (
    <Bench>
      <SchedulesCard stat={EMPTY_STAT} />
      <SchedulesCard stat={POPULATED_STAT} />
    </Bench>
  ),
};
