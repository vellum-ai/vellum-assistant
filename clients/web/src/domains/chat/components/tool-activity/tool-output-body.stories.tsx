import type { Meta, StoryObj } from "@storybook/react-vite";

import { ToolOutputBody } from "./tool-output-body";

/**
 * What an Output section shows: the text when there is some, and otherwise the
 * sentence saying why there is not.
 *
 * This exists so that decision lives in one place. Every renderer that owns its
 * own output would otherwise re-derive "denied versus empty versus still
 * running", and the first one to skip a case tells a user their declined call
 * returned nothing. These four stories are the whole of what it can say, which
 * is why they belong on a page: a new renderer that owns its output should be
 * checked against them.
 */
const meta = {
  title: "Chat/ToolActivity/ToolOutputBody",
  component: ToolOutputBody,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ToolOutputBody>;

export default meta;
type Story = StoryObj<typeof ToolOutputBody>;

const base = { isDenied: false, isRunning: false, isError: false };

/** There is output, so it shows, clamped when long and copyable. */
export const WithText: Story = {
  args: {
    ...base,
    text: "M clients/web/src/domains/chat/components/tool-detail-panel.tsx\n?? clients/web/src/domains/chat/components/tool-input.ts",
  },
};

/** A failed call, tinted so the failure reads at a glance. */
export const Errored: Story = {
  args: { ...base, text: "bash: nope: command not found", isError: true },
};

/** Ran and printed nothing. An empty result is a result. */
export const Empty: Story = { args: { ...base, text: "" } };

/** Nothing yet, because the call has not finished. */
export const Running: Story = { args: { ...base, text: "", isRunning: true } };

/**
 * Never ran. The case that makes this component worth sharing: the same empty
 * block, but the reason is a decision the user made, not an absence of output.
 */
export const Denied: Story = { args: { ...base, text: "", isDenied: true } };
