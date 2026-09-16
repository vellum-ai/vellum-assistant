/**
 * The Current Usage reading that sits where the current plan's price row
 * otherwise would: how much of the usage credit the
 * account was granted is already used, and, once the wallet behind it is
 * empty too, a strip offering to top it up. The reading itself turns
 * negative as soon as the granted credit is used up, whatever the wallet
 * holds.
 *
 * Pure props, so every reading below is a fixture rather than a live usage
 * read. `PlanTile` mounts it as a footer; `Settings/Billing/PlanTile` carries
 * that composition.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { frameWidthDecorator } from "@/domains/settings/billing/story-frame-width";
import { UsageBalancePanel } from "@/domains/settings/billing/usage-balance-panel";

/** The instant a subscriber's billing cycle ends on. */
const PERIOD_END_AT = "2026-09-20T12:00:00Z";

const meta = {
  title: "Settings/Billing/UsageBalancePanel",
  component: UsageBalancePanel,
  parameters: { layout: "centered" },
  args: {
    ratio: 0.68,
    periodEnd: null,
    exhausted: false,
  },
  argTypes: {
    ratio: { control: { type: "range", min: 0, max: 1, step: 0.01 } },
  },
  decorators: [frameWidthDecorator],
} satisfies Meta<typeof UsageBalancePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mid-cycle: two thirds of the granted credit used, with room to spare. */
export const MidCycle: Story = {};

/**
 * A bundled subscriber's panel: the title carries the date the bundle turns
 * over beneath it. The free plan's grant is one-time, so its panel has no such
 * line.
 */
export const Subscriber: Story = {
  args: { periodEnd: { at: PERIOD_END_AT, kind: "resets" } },
};

/**
 * A Custom sub that picked no credit bundle. The subscription still renews on
 * that date, but nothing turns over, so the line names a renewal instead of a
 * reset.
 */
export const SubscriberNoBundle: Story = {
  name: "Subscriber without a bundle",
  args: { periodEnd: { at: PERIOD_END_AT, kind: "renews" } },
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
 * The subscriber's panel at full card width, which is what a current plan with
 * no next tile beside it gets. The bar sits a fixed gap after the title
 * instead of at the far edge, with the slack to the right of the percentage,
 * and the reset line makes the title block two lines that the bar centres
 * against.
 */
export const WideTile: Story = {
  ...Subscriber,
  parameters: { frameWidth: 940 },
};
