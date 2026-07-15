import type { Meta, StoryObj } from "@storybook/react-vite";

import { Notice } from "./notice";

const meta: Meta<typeof Notice> = {
  title: "Components/Notice",
  component: Notice,
  argTypes: {
    tone: {
      control: "select",
      options: ["info", "success", "warning", "error", "neutral", "hint"],
    },
    onDismiss: { action: "dismissed" },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 480 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Notice>;

export const Info: Story = {
  args: {
    tone: "info",
    title: "Information",
    children: "This is an informational notice.",
  },
};

export const Success: Story = {
  args: {
    tone: "success",
    title: "Success",
    children: "Operation completed successfully.",
  },
};

export const Warning: Story = {
  args: {
    tone: "warning",
    title: "Warning",
    children: "Please review before continuing.",
  },
};

export const Error: Story = {
  args: {
    tone: "error",
    title: "Error",
    children: "Something went wrong. Please try again.",
  },
};

export const Hint: Story = {
  args: {
    tone: "hint",
    title: "Tip",
    children: "This is a helpful hint.",
  },
};

export const Neutral: Story = {
  args: {
    tone: "neutral",
    title: "Note",
    children: "A neutral notice without a default icon.",
  },
};

export const Dismissible: Story = {
  args: {
    tone: "info",
    title: "Dismissible",
    children: "Click the X to dismiss this notice.",
    onDismiss: () => {},
  },
};

export const WithActions: Story = {
  args: {
    tone: "warning",
    title: "Action Required",
    children: "Your session is about to expire.",
    actions: (
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button">Renew</button>
        <button type="button">Sign out</button>
      </div>
    ),
  },
};

export const BodyOnly: Story = {
  args: {
    tone: "info",
    children: "A notice without a title — body content only.",
  },
};

export const AllTones: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {(["info", "success", "warning", "error", "neutral", "hint"] as const).map((tone) => (
        <Notice key={tone} tone={tone} title={tone}>
          Example {tone} notice.
        </Notice>
      ))}
    </div>
  ),
};
