/**
 * The pending `ask_question` card, the prompt that docks above the composer
 * while the assistant is waiting on an answer.
 *
 * The card is pure props, so these stories drive it directly. What they are
 * for is the minimized state (LUM-3390): it is a live interaction, and the
 * chevron, the swipe and the tap all land on the same transition, so it wants
 * to be played with rather than screenshotted. Open a story, use the chevron
 * in the header, and on a touch target drag the card down or flick it back up.
 *
 * The `Minimized*` stories start there instead, since that state is where the
 * card is measured against the mock. They are set to the phone viewport, which
 * is where the card is at its most cramped and where the collapse earns its
 * keep. Note that a desktop browser reports a fine pointer at any width, so the
 * numeric hotkey badges stay on; open the story in a device-emulated frame, or
 * on a real phone, to see the card without them.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

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

/**
 * A question long enough to run past the one line the minimized header keeps,
 * which is the shape the collapse actually ships in: the card docks above the
 * composer with the question truncated to whatever the row has left.
 */
const LONG: QuestionEntry = {
  id: "q3",
  question:
    "What's your preferred way to start the engagement, given how much of the positioning work is still open?",
  description: "There is no wrong answer here.",
  options: [
    { id: "discovery", label: "A discovery call first" },
    { id: "audit", label: "An audit of what exists" },
    { id: "pilot", label: "A small paid pilot" },
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
 * A batch. The pager shares the trailing cluster with the minimize chevron, and
 * both leave when the card minimizes, since each of them acts on rows that are
 * on screen. Which question you are on is announced to a screen reader and not
 * drawn: a sighted reader has the options changing under them to say it.
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

/** Lands the story in the minimized state, which is otherwise a click away. */
const minimizeCard: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(
    await canvas.findByRole("button", { name: "Minimize question" }),
  );
};

/**
 * The minimized card, at the width it docks above the composer on a phone. The
 * question truncates to one line, the option count and the way back stand in
 * for the body, and the only control left is the X: the chevron leaves with the
 * rows it collapsed, and the summary itself is what reopens the card. Click it,
 * or tab to it and press Enter.
 */
export const Minimized: Story = {
  args: { entries: [LONG] },
  globals: { viewport: { value: "sbMobile" } },
  play: minimizeCard,
};

/**
 * A minimized batch, which is a plain one-line row: no pager, since there are
 * no options on screen to page between, and no position to report.
 */
export const MinimizedBatched: Story = {
  args: { entries: [MARKONE, CADENCE] },
  globals: { viewport: { value: "sbMobile" } },
  play: minimizeCard,
};

/**
 * The expanded card at phone width, to compare the two against each other: the
 * pager and the one chevron sit in the trailing cluster, and both go away
 * together on the way down.
 */
export const BatchedOnAPhone: Story = {
  args: { entries: [MARKONE, CADENCE] },
  globals: { viewport: { value: "sbMobile" } },
};
