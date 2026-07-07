import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import { toast, Toaster, type ToastTone, type ToastVariant } from "./toast";

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

const TONE_VARIANTS: {
  variant: Exclude<ToastVariant, "default">;
  message: string;
}[] = [
  { variant: "info", message: "Informational message" },
  { variant: "warning", message: "Something needs attention" },
  { variant: "error", message: "Something went wrong" },
  { variant: "success", message: "Action completed" },
];

export const WeakTone: Story = {
  parameters: {
    controls: { disable: true },
    docs: {
      description: {
        story:
          "Weak tone (default) — subdued background with colored text/icon. Includes the iconless `default` variant, which only has a weak tone.",
      },
    },
  },
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Button variant="outlined" onClick={() => toast("Default notification")}>
        Default
      </Button>
      {TONE_VARIANTS.map(({ variant, message }) => (
        <Button
          key={variant}
          variant="outlined"
          onClick={() => toast[variant](message, { tone: "weak" })}
        >
          {variant}
        </Button>
      ))}
    </div>
  ),
};

export const StrongTone: Story = {
  parameters: {
    controls: { disable: true },
    docs: {
      description: {
        story:
          "Strong tone — full-color background with white text/icon. The `default` variant has no strong tone.",
      },
    },
  },
  render: () => (
    <div className="flex flex-wrap gap-2">
      {TONE_VARIANTS.map(({ variant, message }) => (
        <Button
          key={variant}
          variant="outlined"
          onClick={() =>
            toast[variant](message, { tone: "strong" satisfies ToastTone })
          }
        >
          {variant}
        </Button>
      ))}
    </div>
  ),
};
