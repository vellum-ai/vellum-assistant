import type { Meta, StoryObj } from "@storybook/react-vite";

import { ChannelSourceLinkPill } from "./channel-source-link-pill";

/**
 * Top-bar pill linking a channel-bound conversation back to its source
 * thread. The decorator frames it on the header's `--surface-base`
 * backdrop: the pill's active-ghost chrome is `--surface-lift`, so on the
 * default story canvas (white) it would read as an unstyled label.
 *
 * The pill's chrome comes entirely from Button's `asChild` + `leftIcon`
 * path, so the story doubles as a visual check on that seam (LUM-1680):
 * anything other than a rounded white pill means the button props are not
 * reaching the anchor.
 */
const meta = {
  title: "chat/ChannelSourceLinkPill",
  component: ChannelSourceLinkPill,
  decorators: [
    (Story) => (
      <div
        className="flex items-center gap-2 rounded-md p-6"
        style={{ background: "var(--surface-base)" }}
      >
        <Story />
      </div>
    ),
  ],
  argTypes: {
    channelId: {
      control: "inline-radio",
      options: ["slack", "telegram", "email", null],
    },
  },
} satisfies Meta<typeof ChannelSourceLinkPill>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Slack origin: brand glyph + "Open in Slack". */
export const Default: Story = {
  args: {
    href: "https://example.slack.com/archives/C0123456789/p1720000000000000",
    channelId: "slack",
  },
};

/** Non-Slack channels fall back to the generic external-link glyph. */
export const NonSlackChannel: Story = {
  args: {
    href: "https://t.me/c/1234567890/42",
    channelId: "telegram",
  },
};
