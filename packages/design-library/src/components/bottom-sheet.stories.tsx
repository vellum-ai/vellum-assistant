import type { Meta, StoryObj } from "@storybook/react-vite";
import { Share } from "lucide-react";

import { Button } from "./button";
import { BottomSheet } from "./bottom-sheet";

interface BottomSheetStoryArgs {
  title: string;
  description: string;
  showIcon: boolean;
  triggerLabel: string;
}

const meta: Meta<BottomSheetStoryArgs> = {
  title: "Components/BottomSheet",
  parameters: {
    layout: "centered",
  },
  argTypes: {
    title: { control: "text" },
    description: { control: "text" },
    showIcon: { control: "boolean" },
    triggerLabel: { control: "text" },
  },
};

export default meta;
type Story = StoryObj<BottomSheetStoryArgs>;

export const Default: Story = {
  args: {
    triggerLabel: "Open Bottom Sheet",
    title: "Select an Option",
    description: "Choose one of the actions below.",
    showIcon: false,
  },
  render: ({ triggerLabel, title, description, showIcon }) => (
    <BottomSheet.Root>
      <BottomSheet.Trigger asChild>
        <Button>{triggerLabel}</Button>
      </BottomSheet.Trigger>
      <BottomSheet.Content>
        <BottomSheet.Header>
          <BottomSheet.Title icon={showIcon ? Share : undefined}>
            {title}
          </BottomSheet.Title>
          {description ? (
            <BottomSheet.Description>{description}</BottomSheet.Description>
          ) : null}
        </BottomSheet.Header>
        <BottomSheet.Body>
          <div className="flex flex-col gap-2">
            <Button variant="ghost" className="justify-start">
              Option 1
            </Button>
            <Button variant="ghost" className="justify-start">
              Option 2
            </Button>
            <Button variant="ghost" className="justify-start">
              Option 3
            </Button>
          </div>
        </BottomSheet.Body>
        <BottomSheet.Footer>
          <BottomSheet.Close asChild>
            <Button variant="outlined">Cancel</Button>
          </BottomSheet.Close>
        </BottomSheet.Footer>
      </BottomSheet.Content>
    </BottomSheet.Root>
  ),
};

export const WithIcon: Story = {
  args: {
    triggerLabel: "Share",
    title: "Share with",
    description: "",
    showIcon: true,
  },
  render: ({ triggerLabel, title, description, showIcon }) => (
    <BottomSheet.Root>
      <BottomSheet.Trigger asChild>
        <Button variant="outlined">{triggerLabel}</Button>
      </BottomSheet.Trigger>
      <BottomSheet.Content>
        <BottomSheet.Header>
          <BottomSheet.Title icon={showIcon ? Share : undefined}>
            {title}
          </BottomSheet.Title>
          {description ? (
            <BottomSheet.Description>{description}</BottomSheet.Description>
          ) : null}
        </BottomSheet.Header>
        <BottomSheet.Body>
          <div className="flex flex-col gap-2">
            <Button variant="ghost" className="justify-start">
              Copy Link
            </Button>
            <Button variant="ghost" className="justify-start">
              Send via Email
            </Button>
          </div>
        </BottomSheet.Body>
      </BottomSheet.Content>
    </BottomSheet.Root>
  ),
};
