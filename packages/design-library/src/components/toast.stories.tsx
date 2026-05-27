import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import { toast, Toaster, type ToastVariant } from "./toast";

interface ToastStoryArgs {
  variant: ToastVariant;
  message: string;
  description: string;
  withAction: boolean;
  actionLabel: string;
}

const meta: Meta<ToastStoryArgs> = {
  title: "Components/Toast",
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "info", "warning", "error", "success"],
    },
    message: { control: "text" },
    description: { control: "text" },
    withAction: { control: "boolean" },
    actionLabel: { control: "text" },
  },
};

export default meta;
type Story = StoryObj<ToastStoryArgs>;

function fireToast(args: ToastStoryArgs) {
  const options = {
    description: args.description || undefined,
    action: args.withAction
      ? {
          label: args.actionLabel || "Undo",
          onClick: () => toast.success("Action confirmed"),
        }
      : undefined,
  };
  const fn = args.variant === "default" ? toast : toast[args.variant];
  fn(args.message, options);
}

export const WithDescription: Story = {
  args: {
    variant: "info",
    message: "File uploaded",
    description: "your-document.pdf was uploaded successfully.",
    withAction: false,
    actionLabel: "Undo",
  },
  render: (args) => (
    <Button onClick={() => fireToast(args)}>Toast with description</Button>
  ),
};

export const WithAction: Story = {
  args: {
    variant: "error",
    message: "Message deleted",
    description: "",
    withAction: true,
    actionLabel: "Undo",
  },
  render: (args) => (
    <Button onClick={() => fireToast(args)}>Toast with action</Button>
  ),
};

export const AllVariants: Story = {
  parameters: {
    controls: { disable: true },
    docs: {
      description: {
        story:
          "Fires one toast per variant — use the other stories to drive a single toast via controls.",
      },
    },
  },
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Button variant="outlined" onClick={() => toast("Default notification")}>
        Default
      </Button>
      <Button
        variant="outlined"
        onClick={() => toast.info("Informational message")}
      >
        Info
      </Button>
      <Button
        variant="outlined"
        onClick={() => toast.warning("Something needs attention")}
      >
        Warning
      </Button>
      <Button
        variant="outlined"
        onClick={() => toast.error("Something went wrong")}
      >
        Error
      </Button>
      <Button
        variant="outlined"
        onClick={() => toast.success("Action completed")}
      >
        Success
      </Button>
    </div>
  ),
};
