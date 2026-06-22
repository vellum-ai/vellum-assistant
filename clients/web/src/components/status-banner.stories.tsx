import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@vellumai/design-library";
import { Info, LoaderCircle } from "lucide-react";

import { StatusBannerNotice } from "@/components/status-banner";

const meta: Meta<typeof StatusBannerNotice> = {
  title: "Components/StatusBanner",
  component: StatusBannerNotice,
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    tone: {
      control: "select",
      options: ["info", "success", "warning", "error", "neutral"],
    },
    placement: {
      control: "select",
      options: ["web", "electron"],
    },
  },
};

export default meta;

type Story = StoryObj<typeof StatusBannerNotice>;

const action = (
  <Button variant="ghost" size="compact">
    Action
  </Button>
);

export const Web: Story = {
  args: {
    tone: "info",
    placement: "web",
    title: "Assistant is upgrading.",
    icon: <Info aria-hidden="true" />,
    actions: action,
  },
  decorators: [
    (Story) => (
      <div className="w-full">
        <Story />
      </div>
    ),
  ],
};

export const Electron: Story = {
  args: {
    tone: "info",
    placement: "electron",
    title: "Assistant is upgrading.",
    icon: <Info aria-hidden="true" />,
    actions: action,
  },
  decorators: [
    (Story) => (
      <div className="bg-[var(--surface-base)] p-4">
        <Story />
      </div>
    ),
  ],
};

export const ElectronWorking: Story = {
  args: {
    tone: "info",
    placement: "electron",
    title: "Assistant is upgrading.",
    icon: <LoaderCircle className="animate-spin" aria-hidden="true" />,
  },
  decorators: [
    (Story) => (
      <div className="bg-[var(--surface-base)] p-4">
        <Story />
      </div>
    ),
  ],
};
