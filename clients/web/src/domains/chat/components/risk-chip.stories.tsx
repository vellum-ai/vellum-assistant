import type { Meta, StoryObj } from "@storybook/react-vite";

import { RiskChip } from "./risk-chip";

/**
 * The risk level a tool call was classified at, and what that level means for
 * approval.
 *
 * There are two shapes, and which one renders is decided by the device, not by
 * an argument: where hovering is possible the tolerance sentence is the pill's
 * tooltip, and where it is not the sentence renders beside the pill, because
 * the shared `Tooltip` mounts nothing at all without hover. Storybook's own
 * canvas answers `(hover: hover)` the way the viewing device does, so on a
 * desktop these stories show the tooltip form: hover a pill to read its
 * sentence, and tab to it to confirm focus opens the same tooltip. Open this
 * page on a phone or tablet, or with a touch-emulating device toolbar, to see
 * the text form the same stories produce there.
 *
 * `workspace` and unrecognised levels map to no tolerance tier, so they have no
 * sentence in either shape and render as a bare pill.
 */
const meta = {
  title: "Chat/RiskChip",
  component: RiskChip,
  parameters: { layout: "centered" },
} satisfies Meta<typeof RiskChip>;

export default meta;
type Story = StoryObj<typeof RiskChip>;

/** Auto-approved at the most cautious tolerance. */
export const Low: Story = { args: { level: "low" } };

/** The level most tool calls that touch a file land on. */
export const Medium: Story = { args: { level: "medium" } };

/** Approved only at the most permissive tolerance. */
export const High: Story = { args: { level: "high" } };

/**
 * A level with no tolerance tier, so there is no sentence to reach by any
 * means. The pill stands alone rather than carrying an empty tooltip.
 */
export const Workspace: Story = { args: { level: "workspace" } };

/** Anything the classifier did not recognise, shown rather than hidden. */
export const Unrecognised: Story = { args: { level: "banana" } };

/** No classification yet, or none at all: the chip renders nothing. */
export const Absent: Story = { args: { level: undefined } };
