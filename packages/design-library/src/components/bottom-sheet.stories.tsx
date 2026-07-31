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

/**
 * A sheet whose content is itself a surface: `padded={false}` drops the default
 * inset so the fill reaches the rounded top corners, and `className` overrides
 * the default height band so the sheet rests against a chosen edge instead of
 * sizing to its rows. The unpadded sheet owns its own safe-area allowance.
 */
export const FullBleed: Story = {
  args: {
    triggerLabel: "Open full-bleed sheet",
    title: "",
    description: "",
    showIcon: false,
  },
  render: ({ triggerLabel }) => (
    <BottomSheet.Root>
      <BottomSheet.Trigger asChild>
        <Button>{triggerLabel}</Button>
      </BottomSheet.Trigger>
      <BottomSheet.Content
        padded={false}
        className="top-24 max-h-none min-h-0 overflow-hidden"
        aria-label="Full-bleed sheet"
        aria-describedby={undefined}
      >
        <div className="flex flex-1 items-center justify-center bg-[var(--primary-base)] text-[var(--content-inset)]">
          Content reaches every edge
        </div>
      </BottomSheet.Content>
    </BottomSheet.Root>
  ),
};
