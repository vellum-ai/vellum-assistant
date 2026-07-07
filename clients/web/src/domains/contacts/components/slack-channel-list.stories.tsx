import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import type { SlackChannel } from "@/domains/contacts/types";

import { SlackChannelList } from "./slack-channel-list";

function makeChannel(overrides: Partial<SlackChannel> & Pick<SlackChannel, "id" | "name">): SlackChannel {
  return {
    type: "channel",
    isPrivate: false,
    isMember: true,
    memberCount: null,
    topic: null,
    imageUrl: null,
    ...overrides,
  };
}

/**
 * A mix of public channels, private channels, group DMs, and 1:1 DMs — the
 * list renders rooms only, so the 1:1 DM rows stay hidden.
 */
const MIXED_CHANNELS: SlackChannel[] = [
  makeChannel({ id: "C001", name: "general", memberCount: 42 }),
  makeChannel({ id: "C002", name: "engineering", memberCount: 18 }),
  makeChannel({ id: "C003", name: "eng-releases", memberCount: 9 }),
  makeChannel({ id: "C004", name: "design", memberCount: 7 }),
  makeChannel({ id: "C005", name: "leadership", isPrivate: true, memberCount: 4 }),
  makeChannel({ id: "C006", name: "incident-response", isPrivate: true, memberCount: 6 }),
  makeChannel({ id: "D001", name: "Alice", type: "dm" }),
  makeChannel({ id: "D002", name: "Bob", type: "dm" }),
  makeChannel({ id: "G001", name: "Alice, Bob", type: "group", isPrivate: true }),
];

const meta: Meta<typeof SlackChannelList> = {
  title: "Contacts/SlackChannelList",
  component: SlackChannelList,
  args: {
    assistantDisplayName: "Example Assistant",
    slackHandle: "@example-assistant",
    channels: MIXED_CHANNELS,
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 720, margin: "2rem auto" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SlackChannelList>;

/** Loaded list with a mix of public / private channels and DMs. */
export const Loaded: Story = {};

/** No member channels: the empty state carries the `/invite` copy hint. */
export const Empty: Story = {
  args: {
    channels: [],
  },
};

/**
 * `eng-releases` starts overridden to the Standard tier — the row badge
 * reads "Standard • custom" and expanding it shows the custom-capabilities
 * callout with Reset to default (mirrors the ticket mockup's `releases`).
 */
export const OverriddenChannel: Story = {
  args: {
    tierOverrides: { C003: "standard" },
    onTierChange: () => {},
    onTierReset: () => {},
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByLabelText("eng-releases — expand channel settings"),
    );
  },
};

/** Search-as-you-type narrows rows by channel name. */
export const SearchFiltering: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Search channels"), "eng");
  },
};

export const Loading: Story = {
  args: {
    channels: undefined,
    loading: true,
  },
};

export const LoadError: Story = {
  args: {
    channels: undefined,
    error: true,
  },
};

/** Past ~100 rows the list virtualizes into a fixed-height scroller. */
export const ManyChannels: Story = {
  args: {
    channels: Array.from({ length: 250 }, (_, i) =>
      makeChannel({
        id: `C${String(i).padStart(4, "0")}`,
        name: `team-${String(i).padStart(3, "0")}`,
        isPrivate: i % 5 === 0,
        memberCount: (i % 30) + 2,
      }),
    ),
  },
};
