import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import { Notice } from "./notice";

const meta: Meta<typeof Notice> = {
  title: "Components/Notice",
  component: Notice,
  argTypes: {
    tone: {
      control: "select",
      options: ["info", "success", "warning", "error", "neutral"],
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
      <>
        <Button variant="primary" size="compact">
          Renew
        </Button>
        <Button variant="ghost" size="compact">
          Sign out
        </Button>
      </>
    ),
  },
};

/**
 * Several actions inside a narrow notice. The actions sit under the message so
 * the text keeps the full width instead of collapsing into a one-word-per-line
 * column. A notice that offers an explicit "Dismiss" action leaves `onDismiss`
 * unset, so the corner control is not a second way to do the same thing.
 */
export const NarrowWithActions: Story = {
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 340 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    onDismiss: undefined,
    tone: "warning",
    title: "Message not sent. It looks like it contains an API key.",
    children: "Credentials sent in chat are visible in the transcript.",
    actions: (
      <>
        <Button variant="primary" size="compact">
          Store securely
        </Button>
        <Button variant="outlined" size="compact">
          Send anyway
        </Button>
        <Button variant="ghost" size="compact">
          Dismiss
        </Button>
      </>
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
      {(["info", "success", "warning", "error", "neutral"] as const).map((tone) => (
        <Notice key={tone} tone={tone} title={tone}>
          Example {tone} notice.
        </Notice>
      ))}
    </div>
  ),
};
