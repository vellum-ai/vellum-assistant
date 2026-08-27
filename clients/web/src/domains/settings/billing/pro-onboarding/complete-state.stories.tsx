/**
 * The terminal card of the pro-onboarding wizard, shown once the takeover has
 * handed off: a creature-scattered "You're all set!" with a single button back
 * to the assistant.
 *
 * `direction` picks the subtitle, which can only claim an upgrade when the
 * change was one. `assistant` picks whether the button names the assistant it
 * will select or falls back to naming none: the unresolved id is one nothing was
 * seeded for, and Storybook has no daemon to answer the read, which is the same
 * outcome the card handles when the machine it just resized is still coming
 * back.
 *
 * The card is the only step `BillingOnboardingModal` lets the user dismiss, so
 * it renders in the modal's ordinary `size="md"` content box rather than the
 * full-bleed takeover. The decorator mounts that box through the real
 * `Modal.Root` / `Modal.Content`, which is what clips the creatures hanging off
 * the card's edges.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { assistantsRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import { CompleteState } from "./complete-state";
import type { TakeoverDirection } from "./takeover-copy";
import { makeStoryAssistant, WizardStepBox } from "./wizard-step-story-support";

// The card scatters six bundled creatures around its edges from a dynamic
// import, and renders none of them until that chunk resolves.
preloadBundledAvatarComponents();

const RESOLVED_ASSISTANT_ID = "story-assistant-complete";
/** An assistant nothing was seeded for, so the read has nowhere to settle. */
const UNRESOLVED_ASSISTANT_ID = "story-assistant-complete-unresolved";

const ASSISTANT_IDS = {
  resolved: RESOLVED_ASSISTANT_ID,
  unresolved: UNRESOLVED_ASSISTANT_ID,
} satisfies Record<string, string>;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

queryClient.setQueryData(
  assistantsRetrieveQueryKey({ path: { id: RESOLVED_ASSISTANT_ID } }),
  makeStoryAssistant(RESOLVED_ASSISTANT_ID),
);

/** Story-local controls; `assistant` names a seeded id the render looks up. */
interface CompleteStoryArgs {
  direction: TakeoverDirection;
  assistant: keyof typeof ASSISTANT_IDS;
}

function renderComplete(args: CompleteStoryArgs) {
  return (
    <CompleteState
      assistantId={ASSISTANT_IDS[args.assistant]}
      direction={args.direction}
    />
  );
}

const meta: Meta<CompleteStoryArgs> = {
  title: "Settings/Billing/ProOnboarding/CompleteState",
  // A portaled modal overlay is `fixed`, so one docs iframe cannot show this
  // story beside its neighbours.
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    direction: {
      description: "Which way the change that just landed went.",
      control: "radio",
      options: ["upgrade", "downgrade", "change"],
    },
    assistant: {
      description: "Whether the assistant read resolves a name for the button.",
      control: "radio",
      options: Object.keys(ASSISTANT_IDS),
    },
  },
  args: {
    direction: "upgrade",
    assistant: "resolved",
  },
  render: renderComplete,
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
type Story = StoryObj<CompleteStoryArgs>;

/** The finish, driven from the Controls panel. */
export const Playground: Story = {};
