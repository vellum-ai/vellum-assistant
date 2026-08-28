/**
 * The pending `ask_question` card, the prompt that docks above the composer
 * while the assistant is waiting on an answer.
 *
 * The card measures itself, so width is the axis these stories are organised
 * around, and the decorator is what varies. A roomy card puts the question
 * beside the pager on one line and offers no collapse at all; a narrow one
 * stacks the pager above the question and carries a chevron to put the options
 * away. The `Narrow*` stories are the cramped end, which is where the card is
 * measured against the mock.
 *
 * The collapse is a live interaction, and the chevron, the swipe and the header
 * tap all land on the same transition, so it wants to be played with rather
 * than screenshotted. Open a `Narrow` story, use the chevron, and on a touch
 * target drag the card down or flick it back up.
 *
 * A desktop browser reports a fine pointer at any width, so the numeric hotkey
 * badges stay on; open a story in a device-emulated frame, or on a real phone,
 * to see the card without them.
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
 * A question long enough to run past the two lines a collapsed header keeps,
 * which is what bounds the height of a card docked above the composer.
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

/**
 * The width a chat column reaches when the sidebar is closed, which is where
 * the card gets its one-line header.
 */
const roomy: Story["decorators"] = [
  (Story) => (
    <div className="w-[600px] max-w-full">
      <Story />
    </div>
  ),
];

/**
 * A phone, or a desktop column squeezed by the sidebar. Both put the card in
 * the same layout, which is the point of measuring the card rather than the
 * window.
 */
const narrow: Story["decorators"] = [
  (Story) => (
    <div className="w-[386px] max-w-full">
      <Story />
    </div>
  ),
];

/** The default: roomy, one question, four options and the free-text row. */
export const Roomy: Story = {
  args: { entries: [MARKONE] },
  decorators: roomy,
};

/**
 * A batch with room. The count sits inline with the pager on the same line as
 * the question, and the card offers no way to collapse: it is beside the
 * transcript rather than on top of it.
 */
export const RoomyBatched: Story = {
  args: { entries: [MARKONE, CADENCE] },
  decorators: roomy,
};

/** A question with no description, so the header is a single line either way. */
export const NoDescription: Story = {
  args: { entries: [CADENCE] },
  decorators: roomy,
};

/** Mid-submit: every control is disabled, but the card still collapses. */
export const Submitting: Story = {
  args: { entries: [MARKONE], isSubmitting: true },
  decorators: narrow,
};

/**
 * The narrow header: the count and the chevrons take a line of their own above
 * the question, and the chevron on the end puts the options away.
 */
export const Narrow: Story = {
  args: { entries: [MARKONE] },
  decorators: narrow,
};

/** A narrow batch, where the pager earns the line it sits on. */
export const NarrowBatched: Story = {
  args: { entries: [MARKONE, CADENCE] },
  decorators: narrow,
};

/** Lands the story collapsed, which is otherwise a click away. */
const collapseCard: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(
    await canvas.findByRole("button", { name: "Minimize question" }),
  );
};

/**
 * The collapsed card, at the width it docks above the composer on a phone. The
 * header stays whole (question, description, count and pager) and everything
 * under it goes. The chevron turns over to point back up. Click it, tab to it
 * and press Enter, or tap anywhere on the header.
 */
export const Collapsed: Story = {
  args: { entries: [LONG] },
  decorators: narrow,
  globals: { viewport: { value: "sbMobile" } },
  play: collapseCard,
};

/**
 * A collapsed batch, which still pages: the chevrons act on the question the
 * header is showing, and the count follows them.
 */
export const CollapsedBatched: Story = {
  args: { entries: [MARKONE, CADENCE] },
  decorators: narrow,
  globals: { viewport: { value: "sbMobile" } },
  play: collapseCard,
};
