/**
 * The pending `ask_question` card, the prompt that docks above the composer
 * while the assistant is waiting on an answer.
 *
 * The card is pure props, so these stories drive it directly. What they are
 * for is the minimized state (LUM-3390): it is a live interaction, and the
 * chevron, the swipe and the tap all land on the same transition, so it wants
 * to be played with rather than screenshotted. Open a story, use the chevron
 * in the header, and on a touch target drag the card down or flick it back up.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card";
import type { QuestionEntry } from "@/types/interaction-ui-types";

const MARKONE: QuestionEntry = {
  id: "q1",
  question: "What should we build first for MarkOne?",
  description:
    "Pick the most useful starting point, or type your own direction.",
  options: [
    { id: "offer", label: "Define the offer and positioning" },
    { id: "clients", label: "Choose the ideal clients" },
    { id: "acquisition", label: "Build the client acquisition system" },
    { id: "workflow", label: "Design the AI delivery workflow" },
  ],
};

const CADENCE: QuestionEntry = {
  id: "q2",
  question: "How often should it report back?",
  options: [
    { id: "daily", label: "Every morning" },
    { id: "weekly", label: "Once a week" },
    { id: "never", label: "Only when something changes" },
  ],
};

const meta: Meta<typeof QuestionPromptCard> = {
  title: "Chat/QuestionPromptCard",
  component: QuestionPromptCard,
  parameters: { layout: "padded" },
  args: {
    requestId: "req-1",
    isSubmitting: false,
    onSubmitAll: () => {},
    onClose: () => {},
  },
  decorators: [
    (Story) => (
      // The card is laid out against the chat column, which is capped well
      // short of the viewport. Anything wider reads as a different component.
      <div className="max-w-[--chat-max-width]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof QuestionPromptCard>;

/** The default: expanded, one question, four options and the free-text row. */
export const Expanded: Story = {
  args: { entries: [MARKONE] },
};

/**
 * A batch. The pager appears beside the counter, and both leave when the card
 * minimizes, since paging is an expanded-card action.
 */
export const Batched: Story = {
  args: { entries: [MARKONE, CADENCE] },
};

/** A question with no description, so the header is a single line to begin with. */
export const NoDescription: Story = {
  args: { entries: [CADENCE] },
};

/** Mid-submit: every control is disabled, but the card still minimizes. */
export const Submitting: Story = {
  args: { entries: [MARKONE], isSubmitting: true },
};

/** No `onClose`, so the card renders without its X and Escape does nothing. */
export const NotDismissible: Story = {
  args: { entries: [MARKONE], onClose: undefined },
};
