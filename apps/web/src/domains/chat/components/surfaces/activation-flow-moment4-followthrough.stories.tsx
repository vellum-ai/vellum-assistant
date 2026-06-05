import type { Meta, StoryObj } from "@storybook/react-vite";

import type { QuestionEntry } from "@/types/interaction-ui-types";

import {
  PERSONA_PORTER,
  followThroughCadenceSurface,
} from "./activation-personas";
import { QuestionPromptDemo, SurfacePreview } from "./activation-story-helpers";

/**
 * Moment 4: Follow-through — continuity specific to what just happened, asked
 * through the real ask-a-question UI (`QuestionPromptCard`). This is where the
 * learning-relationship paradigm gets named: the recurring-brief option says it
 * will "get sharper at the angle you act on." The cadence confirmation handles
 * the actual scheduling once accepted.
 */
const meta: Meta = {
  title: "ActivationFlow/Moment4-Followthrough",
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

const followThroughQuestion: QuestionEntry = {
  id: "follow-through",
  question: "Want me to keep on top of this every morning?",
  description:
    "A weekday 7:30 AM brief would flag investor threads and the replies you owe.",
  options: [
    {
      id: "brief",
      label: "Set up a morning brief",
      description:
        "Weekdays at 7:30 AM — and I'll get sharper at the angle you actually act on.",
    },
    {
      id: "draft",
      label: "Just draft the two replies for now",
      description: "I'll prep them for your review, nothing sent.",
    },
  ],
  freeTextPlaceholder: "Something else",
};

export const FollowThroughQuestion: Story = {
  render: () => <QuestionPromptDemo entry={followThroughQuestion} />,
};

/** Once accepted, scheduling is confirmed with the actual cadence. */
export const CadenceConfirmation: Story = {
  name: "Cadence confirmation",
  render: () => (
    <SurfacePreview initialSurface={followThroughCadenceSurface(PERSONA_PORTER)} />
  ),
};
