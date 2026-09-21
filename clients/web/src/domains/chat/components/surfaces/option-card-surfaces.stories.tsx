import type { Meta, StoryObj } from "@storybook/react-vite";

import type { Surface } from "@/domains/chat/types/types";

import { OnboardingChoiceCard } from "@/domains/chat/components/onboarding-choice-card";
import { TranscriptColumn } from "@/domains/chat/transcript/transcript-column";

import { CardSurface } from "./card-surface";
import { SurfaceRouter } from "./surface-router";

/**
 * The chat surfaces whose options are `OptionCard`s, side by side so their
 * marks, selected look and keyboard behaviour can be compared in one place.
 * The single-choice surface lives in `Chat/Surfaces/ChoiceAndCopy`.
 */
const meta: Meta = {
  title: "Chat/Surfaces/OptionCards",
  parameters: {
    layout: "padded",
    controls: { disable: true },
  },
  decorators: [
    (Story) => (
      <TranscriptColumn>
        <Story />
      </TranscriptColumn>
    ),
  ],
};

export default meta;
type Story = StoryObj;

const taskPreferencesSurface: Surface = {
  surfaceId: "task-preferences-surface",
  surfaceType: "task_preferences",
  data: {},
};

const watchRetroSurface = {
  surfaceId: "watch-retro-surface",
  surfaceType: "card",
  data: {
    title: "Filing a Linear bug from a Sentry alert",
    subtitle: "So an overnight crash has a ticket by morning.",
    body: "1. Open the Sentry issue\n2. New Linear issue in JARVIS",
    template: "watch_retro",
    templateData: {
      task: "Filing a Linear bug from a Sentry alert",
      purpose: "So an overnight crash has a ticket by morning.",
      eyebrow: "Watched 4 min · 11 screens",
      steps: ["Open the Sentry issue", "New Linear issue in JARVIS"],
      questions: [
        {
          id: "priority",
          kind: "pick",
          prompt: "You set this one to High. What decides that?",
          options: [
            { id: "events", label: "Over 100 events", note: "my reading" },
            { id: "customer", label: "It hit a customer" },
          ],
        },
        {
          id: "resolve",
          kind: "gate",
          prompt: "Resolving the Sentry issue, on my own?",
          options: [
            { id: "ask", label: "Ask me first" },
            { id: "go", label: "Go ahead" },
          ],
        },
      ],
    },
  },
} as Surface;

/**
 * Multi-select tiles. Select a few, then "Other": its free-text field opens
 * under the grid.
 */
export const TaskPreferences: Story = {
  render: () => (
    <SurfaceRouter surface={taskPreferencesSurface} onAction={() => {}} />
  ),
};

/**
 * The onboarding card's second phase holds the same tiles. Choose
 * "Let's chat" to reach them.
 */
export const OnboardingChoice: Story = {
  render: () => (
    <OnboardingChoiceCard
      onSelectSpecific={() => {}}
      onSubmitTasks={() => {}}
    />
  ),
};

/**
 * Tap-to-commit answers, on the question pages after the recap ("Looks
 * right"). Arrow keys move focus without selecting, because a selection here
 * advances the page.
 */
export const WatchRetro: Story = {
  render: () => <CardSurface surface={watchRetroSurface} onAction={() => {}} />,
};
