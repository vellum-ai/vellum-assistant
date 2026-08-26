/**
 * The terminal card of the pro-onboarding wizard, shown once the takeover has
 * handed off: a creature-scattered "You're all set!" with a single button back
 * to the assistant.
 *
 * The card is the only step `BillingOnboardingModal` lets the user dismiss, so
 * it renders in the modal's ordinary `size="md"` content box rather than the
 * full-bleed takeover. The decorator mounts that box through the real
 * `Modal.Root` / `Modal.Content`, which is what clips the creatures hanging off
 * the card's edges.
 *
 * `tags: ["!autodocs"]` because a modal's overlay is `fixed`: all three stories
 * share one docs iframe, so they would stack on top of each other there.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { assistantsRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import { CompleteState } from "./complete-state";
import { makeStoryAssistant, WizardStepBox } from "./wizard-step-story-support";

// The card scatters six bundled creatures around its edges from a dynamic
// import, and renders none of them until that chunk resolves.
preloadBundledAvatarComponents();

const STORY_ASSISTANT_ID = "story-assistant-complete";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

queryClient.setQueryData(
  assistantsRetrieveQueryKey({ path: { id: STORY_ASSISTANT_ID } }),
  makeStoryAssistant(STORY_ASSISTANT_ID),
);

const meta: Meta<typeof CompleteState> = {
  title: "Settings/Billing/ProOnboarding/CompleteState",
  component: CompleteState,
  // See the file header: a portaled modal overlay is `fixed`, so one docs
  // iframe cannot show these stories side by side.
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    assistantId: STORY_ASSISTANT_ID,
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <WizardStepBox>
          <Story />
        </WizardStepBox>
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof CompleteState>;

/** The post-checkout finish: the button names the assistant it will select. */
export const Upgrade: Story = {
  name: "Upgrade",
  args: {
    direction: "upgrade",
  },
};

/**
 * The same card after an in-place plan change, which can't claim an upgrade, so
 * the subtitle states only that the change is live.
 */
export const PlanChange: Story = {
  name: "Plan change",
  args: {
    direction: "downgrade",
  },
};

/**
 * No provisioning target was named and no active assistant resolves, so the
 * button falls back to naming none. Storybook has no daemon to answer the
 * active-assistant read, which is the same outcome the card handles when the
 * machine it just resized is still coming back.
 */
export const NoAssistantResolved: Story = {
  name: "No assistant resolved",
  args: {
    assistantId: null,
    direction: "upgrade",
  },
};
