import type { Meta, StoryObj } from "@storybook/react-vite";

import { SecretPromptCard } from "./secret-prompt-card";

function noop() {}

const meta: Meta<typeof SecretPromptCard> = {
  title: "Chat/SecretPromptCard",
  component: SecretPromptCard,
  parameters: {
    layout: "padded",
  },
  args: {
    isSubmitting: false,
    saved: false,
    onSave: noop,
    onSendOnce: noop,
    onCancel: noop,
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SecretPromptCard>;

const hubspotSecret = {
  requestId: "req-1",
  service: "hubspot",
  field: "app_token",
  description:
    "Instructions on where to find the token/key shall be written here so the user can easily find it.",
  placeholder: "xapp-",
  purpose: "Access HubSpot CRM contacts and deals",
  allowedDomains: ["api.hubspot.com"],
};

export const Default: Story = {
  args: {
    secret: hubspotSecret,
  },
};

export const Minimal: Story = {
  args: {
    secret: {
      requestId: "req-2",
      label: "API Key",
    },
  },
};

export const WithToolsAndSendOnce: Story = {
  args: {
    secret: {
      ...hubspotSecret,
      requestId: "req-3",
      allowedTools: ["crm_search", "crm_update"],
      allowOneTimeSend: true,
    },
  },
};

export const Submitting: Story = {
  args: {
    secret: hubspotSecret,
    isSubmitting: true,
  },
};

export const Saved: Story = {
  args: {
    secret: hubspotSecret,
    saved: true,
  },
};
