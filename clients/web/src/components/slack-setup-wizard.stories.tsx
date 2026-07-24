import type { Meta, StoryObj } from "@storybook/react-vite";

import { SlackSetupWizard } from "./slack-setup-wizard";

const meta: Meta<typeof SlackSetupWizard> = {
  title: "Contacts/SlackSetupWizard",
  component: SlackSetupWizard,
  args: {
    assistantName: "Example Assistant",
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 800, margin: "2rem auto" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SlackSetupWizard>;

export const Default: Story = {};

export const Saving: Story = {
  args: { saveStatus: "pending" },
};

export const Saved: Story = {
  args: { saveStatus: "success" },
};

export const SaveFailed: Story = {
  args: {
    saveStatus: "error",
    saveError: "Slack rejected the bot token (invalid_auth).",
  },
};
