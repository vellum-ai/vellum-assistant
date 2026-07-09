import type { Meta, StoryObj } from "@storybook/react-vite";
import { MemoryRouter } from "react-router";

import { ProvenancePill } from "./provenance-pill";

/**
 * Cascade provenance pill for a contact channel's effective access — names
 * the layer the admission floor comes from. The channel-default state links
 * "Channels → Slack" to that channel's sub-tab on the Channels page, so the
 * stories mount inside a router.
 */
const meta: Meta<typeof ProvenancePill> = {
  title: "Contacts/ProvenancePill",
  component: ProvenancePill,
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof ProvenancePill>;

export const GlobalDefault: Story = {
  args: {
    provenance: { source: "global-default" },
  },
};

export const ChannelDefaultSlack: Story = {
  args: {
    provenance: { source: "channel-default", channel: "slack" },
  },
};

export const ChannelDefaultTelegram: Story = {
  args: {
    provenance: { source: "channel-default", channel: "telegram" },
  },
};
