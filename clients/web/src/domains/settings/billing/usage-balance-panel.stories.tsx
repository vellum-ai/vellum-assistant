/**
 * The Usage Balance reading that the `obscure-credits` flag puts where the
 * current plan's price row used to sit: how much of the package's included
 * usage this cycle has spent, when it resets, and, once the wallet behind it
 * is empty too, a strip offering to top it up. The reading itself turns
 * negative as soon as the bundle is spent, whatever the wallet holds.
 *
 * Pure props, so every reading below is a fixture rather than a live usage
 * read. `PlanTile` mounts it as a footer; `Settings/Billing/PlanTile` carries
 * that composition.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { UsageBalancePanel } from "@/domains/settings/billing/usage-balance-panel";

/** The width the billing Plan row gives the current-plan tile. */
const TILE_WIDTH_PX = 420;

/** The cycle end every story quotes, so the reset date reads the same. */
const RESETS_AT = "2026-09-01T00:00:00Z";

const meta = {
  title: "Settings/Billing/UsageBalancePanel",
  component: UsageBalancePanel,
  parameters: { layout: "centered" },
  args: {
    ratio: 0.68,
    resetsAt: RESETS_AT,
    exhausted: false,
  },
  argTypes: {
    ratio: { control: { type: "range", min: 0, max: 1, step: 0.01 } },
  },
  decorators: [
    (Story) => (
      // The panel fills whatever column the plan tile gives it, so pin that
      // width rather than letting the centered layout shrink-wrap it.
      <div style={{ width: TILE_WIDTH_PX }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UsageBalancePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mid-cycle: two thirds of the included bundle spent, with room to spare. */
export const MidCycle: Story = {};

/**
 * The bundle fully spent, with credits remaining in the wallet behind it. The
 * bar and the percentage read negative the moment the allowance runs out, but
 * the next turn still has something to draw on, so no strip appears.
 */
export const FullyUsed: Story = {
  name: "Fully used, credits remaining",
  args: { ratio: 1 },
};

/**
 * A spent bundle with an empty wallet behind it. The same negative reading as
 * above, now with the add-credits strip dropped in below it.
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
 * A free plan's reading: lifetime spend measured against every credit the
 * account was granted, rather than a monthly bundle. A grant is not a
 * cycle, so the reset line under the title is gone.
 */
export const HeldCredits: Story = {
  name: "Held credits, nothing resets",
  args: { ratio: 0.68, resetsAt: null },
};
