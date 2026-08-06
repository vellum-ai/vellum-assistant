import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

import { InlineConfirmationCard } from "./tool-call-chip";

/**
 * Build a tool call carrying a pending confirmation. Defaults mirror the
 * Figma spec (New App / node 6648:95696): an activity meta line, a
 * human-readable ask, allowlist options (→ split Allow button), and input
 * details behind the "Show Details" disclosure.
 */
function makeConfirmationToolCall(
  overrides: {
    activity?: string | null;
    description?: string | null;
    riskReason?: string | null;
    allowlistOptions?: boolean;
    input?: Record<string, unknown> | null;
  } = {},
): ChatMessageToolCall {
  const {
    activity = "Writing the SVG library",
    description = "Allow running a command on your computer looking at the most recent files in your Downloads folder?",
    riskReason = null,
    allowlistOptions = true,
    input = { command: "ls -lt ~/Downloads | head -20" },
  } = overrides;
  return {
    id: "tc-confirm",
    name: "bash",
    input: {
      ...(input ?? {}),
      ...(activity ? { activity } : {}),
    },
    startedAt: 1_717_000_000_000,
    pendingConfirmation: {
      requestId: "req-1",
      riskLevel: "high",
      ...(description ? { description } : {}),
      ...(riskReason ? { riskReason } : {}),
      ...(input ? { input } : {}),
      ...(allowlistOptions
        ? {
            allowlistOptions: [
              {
                label: "Allow this exact command",
                description: "Only this exact command line",
                pattern: "ls -lt ~/Downloads | head -20",
              },
            ],
          }
        : {}),
    },
  };
}

const meta: Meta<typeof InlineConfirmationCard> = {
  title: "Chat/InlineConfirmationCard",
  component: InlineConfirmationCard,
  parameters: {
    layout: "padded",
  },
  args: {
    isSubmitting: false,
    onSubmit: () => {},
    onAllowAndCreateRule: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof InlineConfirmationCard>;

/**
 * The Figma reference state: meta line with activity, the ask as the body,
 * split Allow (allowlist options present) + Deny, and the Show Details
 * disclosure below the divider.
 */
export const Default: Story = {
  args: {
    toolCall: makeConfirmationToolCall(),
  },
};

/** No allowlist options — the Allow button renders plain (no split chevron). */
export const PlainAllow: Story = {
  args: {
    toolCall: makeConfirmationToolCall({ allowlistOptions: false }),
  },
};

/**
 * Older daemons send only `riskReason` — it takes the body slot so the user
 * still sees why the gate fired.
 */
export const RiskReasonBody: Story = {
  args: {
    toolCall: makeConfirmationToolCall({
      activity: "Creating recurring Vinted monitor schedule",
      description: null,
      riskReason:
        "Schedule in script mode runs an arbitrary shell command on the host without going through the bash permission classifier",
    }),
  },
};

/** No input payload — the divider + Show Details disclosure are omitted. */
export const NoDetails: Story = {
  args: {
    toolCall: makeConfirmationToolCall({ input: null }),
  },
};

/** Submission in flight — buttons disabled, spinner on Allow. */
export const Submitting: Story = {
  args: {
    toolCall: makeConfirmationToolCall(),
    isSubmitting: true,
  },
};
