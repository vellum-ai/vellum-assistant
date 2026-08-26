/**
 * The card the provisioning step falls back to when the billing reads
 * themselves fail.
 *
 * This is deliberately not the locked full-bleed takeover: a light error card
 * marooned in a dark full-screen viewport leaves the user with nothing to act
 * on, so `BillingOnboardingModal` drops back to its ordinary `size="md"` box,
 * which the decorator mounts through the real `Modal.Root` / `Modal.Content`.
 *
 * `tags: ["!autodocs"]` because a modal's overlay is `fixed`: both stories
 * share one docs iframe, so they would stack on top of each other there.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { FetchErrorState } from "./error-states";
import { WizardStepBox } from "./wizard-step-story-support";

const meta: Meta<typeof FetchErrorState> = {
  title: "Settings/Billing/ProOnboarding/FetchErrorState",
  component: FetchErrorState,
  // See the file header: a portaled modal overlay is `fixed`, so one docs
  // iframe cannot show these stories side by side.
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    onGoToBilling: () => {},
  },
  decorators: [
    (Story) => (
      <WizardStepBox hideCloseButton>
        <Story />
      </WizardStepBox>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof FetchErrorState>;

/** After a checkout: the upgrade may still be processing, so nothing is undone. */
export const Upgrade: Story = {
  name: "Upgrade",
  args: {
    direction: "upgrade",
  },
};

/** The same failure watching an in-place plan change, which claims no upgrade. */
export const PlanChange: Story = {
  name: "Plan change",
  args: {
    direction: "downgrade",
  },
};
