/**
 * The usage panel on its own, one story per reading it draws. Pure props, so
 * every reading below is a fixture rather than a live usage read; `PlanTile`
 * mounts the panel as a footer, and `Settings/Billing/PlanTile` carries that
 * composition. Every story mounts its reading inside the panel, since the
 * reading lays itself out on the panel's columns.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  frameWidthDecorator,
  STORY_PERIOD_END,
} from "@/domains/settings/billing/billing-story-frame";
import { UsageBalancePanel } from "@/domains/settings/billing/usage-balance-panel";
import { UsageBalanceReading } from "@/domains/settings/billing/usage-balance-reading";

const meta = {
  title: "Settings/Billing/UsageBalancePanel",
  component: UsageBalanceReading,
  parameters: { layout: "centered" },
  args: {
    ratio: 0.68,
    title: "Overall Usage",
    exhausted: false,
  },
  argTypes: {
    ratio: { control: { type: "range", min: 0, max: 1, step: 0.01 } },
  },
  decorators: [
    (Story) => (
      <UsageBalancePanel>
        <Story />
      </UsageBalancePanel>
    ),
    frameWidthDecorator,
  ],
} satisfies Meta<typeof UsageBalanceReading>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mid-cycle: two thirds of the granted credit used, with room to spare. */
export const MidCycle: Story = {};

/**
 * A bundled subscriber's reading: the month's, with the date the bundle
 * resets beneath the title. The free plan's grant is one-time, so its
 * reading is the overall one and has no such line.
 */
export const Subscriber: Story = {
  args: { title: "Monthly Usage", periodEnd: STORY_PERIOD_END },
};

/**
 * A Custom sub that picked no credit bundle, so nothing turns over and the
 * line names a renewal instead; see `UsagePeriodEnd`.
 */
export const SubscriberNoBundle: Story = {
  name: "Subscriber without a bundle",
  args: {
    title: "Monthly Usage",
    periodEnd: { ...STORY_PERIOD_END, kind: "renews" },
  },
};

/**
 * The grants fully used, with credits remaining in the wallet behind them. The
 * bar and the percentage read negative the moment the allowance runs out, but
 * the next turn still has something to draw on, so no strip appears.
 */
export const FullyUsed: Story = {
  name: "Fully used, credits remaining",
  args: { ratio: 1 },
};

/**
 * Used-up grants with an empty wallet behind them. The same negative reading
 * as above, now with the add-credits strip dropped in below it.
 */
export const Exhausted: Story = {
  args: { ratio: 1, exhausted: true, onAddCredits: () => {} },
};

/**
 * The same exhausted state with no `onAddCredits` handler. The strip keeps its
 * message and drops the button, which is what a caller with nowhere to send
 * the user gets.
 */
export const ExhaustedWithoutCta: Story = {
  name: "Exhausted, no CTA",
  args: { ratio: 1, exhausted: true },
};

/**
 * A free-tier account under the platform's daily cap: today's reading above
 * the overall one, in the one panel. The labels and the percentages differ in
 * width, and the shared columns keep both bars starting and ending on the
 * same lines.
 */
export const FreeTierDaily: Story = {
  name: "Free tier, daily and overall",
  args: {
    ratio: 0.4,
    title: "Daily Usage",
    line: "Resets at 5:00 PM",
    barLabel: "Daily Usage, resets at 5:00 PM",
    testId: "plan-daily-usage",
    lineTestId: "plan-daily-usage-resets",
  },
  render: (args) => (
    <>
      <UsageBalanceReading {...args} />
      <UsageBalanceReading ratio={1} title="Overall Usage" />
    </>
  ),
};

/**
 * The subscriber's reading at full card width, which is what a current plan
 * with no next tile beside it gets. The bar sits a fixed gap after the title
 * and stretches to the percentage, and the reset line makes the title block
 * two lines that the bar centres against.
 */
export const WideTile: Story = {
  ...Subscriber,
  parameters: { frameWidth: 940 },
};
