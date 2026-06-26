import type { Meta, StoryObj } from "@storybook/react-vite";

import { SlackSetupWizard } from "./slack-setup-wizard";

const meta: Meta<typeof SlackSetupWizard> = {
  title: "Contacts/SlackSetupWizard",
  component: SlackSetupWizard,
  args: {
    assistantName: "Example Assistant",
  },
};

export default meta;

type Story = StoryObj<typeof SlackSetupWizard>;

export const Step1CreateApp: Story = {};

export const Step2AppToken: Story = {
  args: {
    initialStepId: "app-token",
  },
};

export const Step3BotToken: Story = {
  args: {
    initialStepId: "bot-token",
    onSave: async (_botToken: string, _appToken: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    },
  },
};
