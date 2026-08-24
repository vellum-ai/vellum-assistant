/**
 * The inline "Connect Claude Code" card rendered under a failed `acp_spawn`
 * tool call (missing or rejected `claude-agent-acp` OAuth token).
 *
 * The exported `AcpConnectAffordance` wrapper is hook-coupled: a daemon
 * version gate, a live already-connected self-heal check, and flow state
 * driven by the daemon's Connect routes. These stories drive the two
 * pure-props cards directly with a stubbed connection instead.
 *
 * One-step is the desktop/loopback shape: a single Connect click is the whole
 * flow, so every phase lives in the subtitle beside one action slot. Two-step
 * is the browser/cloud shape: Connect opens a tab, then the paste step adds a
 * masked key field + Save row under the same header.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import type { UseConnectClaudeResult } from "@/hooks/use-connect-claude";

import { OneStepCard, TwoStepCard } from "./acp-connect-affordance";

function stubConnection(
  overrides: Partial<UseConnectClaudeResult> = {},
): UseConnectClaudeResult {
  return {
    phase: "idle",
    mode: null,
    error: null,
    isBusy: false,
    connect: async () => {},
    submitPastedCode: async () => {},
    reset: () => {},
    ...overrides,
  };
}

/** The paste step owns its field value, so give the story real input state. */
function TwoStepHarness({
  connection,
  initialPastedCode = "",
}: {
  connection: UseConnectClaudeResult;
  initialPastedCode?: string;
}) {
  const [pastedCode, setPastedCode] = useState(initialPastedCode);
  return (
    <TwoStepCard
      connection={connection}
      pastedCode={pastedCode}
      onPastedCodeChange={setPastedCode}
    />
  );
}

const meta: Meta = {
  title: "Chat/AcpConnectAffordance",
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

/** The resting one-step card: icon, title, subtitle, and Connect. */
export const OneStepIdle: Story = {
  render: () => <OneStepCard connection={stubConnection()} />,
};

/** Sign-in tab opened; the action slot swaps to a spinner while polling. */
export const OneStepWaiting: Story = {
  render: () => (
    <OneStepCard
      connection={stubConnection({ phase: "awaiting_capture", isBusy: true })}
    />
  ),
};

/**
 * A failed start (here: blocked pop-up). The error takes the subtitle slot and
 * Connect stays available for a retry.
 */
export const OneStepError: Story = {
  render: () => (
    <OneStepCard
      connection={stubConnection({
        phase: "error",
        error:
          "Your browser blocked the sign-in tab. Allow pop-ups for this site, then click Connect again.",
      })}
    />
  ),
};

/** Token captured; the card confirms before the auto-continue send clears it. */
export const OneStepConnected: Story = {
  render: () => (
    <OneStepCard connection={stubConnection({ phase: "connected" })} />
  ),
};

/** The resting two-step card is identical to one-step until the flow starts. */
export const TwoStepIdle: Story = {
  render: () => <TwoStepHarness connection={stubConnection()} />,
};

/** The paste step: subtitle flips to the instruction, key field + Save appear. */
export const TwoStepAwaitingPaste: Story = {
  render: () => (
    <TwoStepHarness
      connection={stubConnection({ phase: "awaiting_paste", mode: "manual" })}
    />
  ),
};

/**
 * A failed exchange (bad/expired code) returns to the paste step with the
 * error in the subtitle and the field value kept for a retry.
 */
export const TwoStepPasteError: Story = {
  render: () => (
    <TwoStepHarness
      connection={stubConnection({
        phase: "awaiting_paste",
        mode: "manual",
        error: "Check the pasted key and try again.",
      })}
      initialPastedCode="bad-code#state"
    />
  ),
};

/** The exchange succeeded; same confirmation row as one-step. */
export const TwoStepConnected: Story = {
  render: () => (
    <TwoStepHarness
      connection={stubConnection({ phase: "connected", mode: "manual" })}
    />
  ),
};
