import type { Meta, StoryObj } from "@storybook/react-vite";

import type { QuestionEntry } from "@/types/interaction-ui-types";

import { QuestionPromptDemo } from "./activation-story-helpers";

/**
 * Moment 2: Propose — the assistant uses what it learned to propose a meaningful
 * first outcome, asked through the real ask-a-question UI (`QuestionPromptCard`).
 * The recommendation is concrete and anchored to Moment 1's context; the user
 * accepts or redirects. Proposing is OUTPUT — it writes nothing to memory.
 */
const meta: Meta = {
  title: "ActivationFlow/Moment2-Propose",
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-[560px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

const proposeQuestion: QuestionEntry = {
  id: "propose-outcome",
  question: "Want me to start by cleaning up your inbox?",
  description:
    "You mentioned investor threads getting buried — I'll surface them and protect anything from Maya.",
  options: [
    {
      id: "inbox",
      label: "Yes — clean up my inbox",
      description: "Archive the noise, protect Maya, surface the replies you owe.",
    },
    {
      id: "calendar",
      label: "Protect my calendar first",
      description: "Block focus time for the raise instead.",
    },
  ],
  freeTextPlaceholder: "Tell me what to start with",
};

export const ProposeQuestion: Story = {
  render: () => <QuestionPromptDemo entry={proposeQuestion} />,
};
