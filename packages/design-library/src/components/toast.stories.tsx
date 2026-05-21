import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";
import { toast, Toaster } from "./toast.js";

const meta: Meta = {
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
};

export default meta;
type Story = StoryObj;

export const WithDescription: Story = {
  render: () => (
    <Button
      onClick={() =>
        toast.info("File uploaded", {
          description: "your-document.pdf was uploaded successfully.",
        })
      }
    >
      Toast with description
    </Button>
  ),
};

export const WithAction: Story = {
  render: () => (
    <Button
      onClick={() =>
        toast.error("Message deleted", {
          action: {
            label: "Undo",
            onClick: () => toast.success("Message restored"),
          },
        })
      }
    >
      Toast with action
    </Button>
  ),
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outlined"
        onClick={() => toast("Default notification")}
      >
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
