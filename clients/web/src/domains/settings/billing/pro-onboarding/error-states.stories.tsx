/**
 * The card the provisioning step falls back to when the billing reads
 * themselves fail. `direction` picks the body copy, which may only name an
 * upgrade when the change whose reads failed was one.
 *
 * This is deliberately not the locked full-bleed takeover: a light error card
 * marooned in a dark full-screen viewport leaves the user with nothing to act
 * on, so `BillingOnboardingModal` drops back to its ordinary `size="md"` box,
 * which the decorator mounts through the real `Modal.Root` / `Modal.Content`.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { FetchErrorState } from "./error-states";
import { WizardStepBox } from "./wizard-step-story-support";

const meta: Meta<typeof FetchErrorState> = {
  title: "Settings/Billing/ProOnboarding/FetchErrorState",
  component: FetchErrorState,
  // A portaled modal overlay is `fixed`, so one docs iframe cannot show this
  // story beside its neighbours.
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    direction: {
      control: "radio",
      options: ["upgrade", "downgrade", "change"],
    },
  },
  args: {
    direction: "upgrade",
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

/** The failure card, driven from the Controls panel. */
export const Playground: Story = {};
