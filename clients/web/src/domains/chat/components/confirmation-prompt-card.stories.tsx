import type { Meta, StoryObj } from "@storybook/react-vite";

import { ConfirmationPromptCard } from "./confirmation-prompt-card";

/**
 * The standalone confirmation card the transcript renders for a pending
 * permission gate (`pending-confirmation-row`), as distinct from the inline
 * card on a tool call (`Chat/InlineConfirmationCard`).
 *
 * Both cards hang the same "Allow & Create Rule" menu off the chevron half of
 * their split Allow button, so this story is where that menu's keyboard
 * contract is reviewable on this card: Down or Enter on the chevron opens the
 * menu and moves focus onto the command, Escape closes it and returns focus to
 * the chevron.
 */
const meta: Meta<typeof ConfirmationPromptCard> = {
  title: "Chat/ConfirmationPromptCard",
  component: ConfirmationPromptCard,
  parameters: {
    layout: "padded",
  },
  args: {
    isSubmitting: false,
    onSubmit: () => {},
    onAllowAndCreateRule: () => {},
    confirmation: {
      requestId: "req-1",
      title: "Run a command on your computer?",
      description:
        "Allow running a command on your computer looking at the most recent files in your Downloads folder?",
      toolName: "bash",
      riskLevel: "high",
      allowlistOptions: [
        {
          label: "Allow this exact command",
          description: "Only this exact command line",
          pattern: "ls -lt ~/Downloads | head -20",
        },
      ],
      input: { command: "ls -lt ~/Downloads | head -20" },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ConfirmationPromptCard>;

/** Allowlist options present, so Allow renders as a split button. */
export const Default: Story = {};

/** No allowlist options: Allow renders plain, with no chevron and no menu. */
export const PlainAllow: Story = {
  args: {
    confirmation: {
      ...meta.args!.confirmation!,
      allowlistOptions: [],
    },
    onAllowAndCreateRule: undefined,
  },
};

/**
 * Older daemons send only `riskReason`, which the card shows under the title
 * so the user still sees why the gate fired.
 */
export const RiskReasonOnly: Story = {
  args: {
    confirmation: {
      ...meta.args!.confirmation!,
      description: undefined,
      riskReason:
        "Schedule in script mode runs an arbitrary shell command on the host without going through the bash permission classifier",
    },
  },
};

/** Submission in flight: both decisions disabled, spinner on Allow. */
export const Submitting: Story = {
  args: { isSubmitting: true },
};
