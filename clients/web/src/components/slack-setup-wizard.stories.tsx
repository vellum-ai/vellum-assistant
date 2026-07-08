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

export const Step1CreateApp: Story = {};

export const Step2GenerateAppToken: Story = {
  args: {
    initialStepId: "app-token",
  },
};

export const Step3InstallAndConnect: Story = {
  args: {
    initialStepId: "install-and-connect",
    onSave: async (_botToken: string, _appToken: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    },
  },
};
