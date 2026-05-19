import type { Meta, StoryObj } from "@storybook/react-vite";
import { Share } from "lucide-react";

import { Button } from "./button.js";
import { BottomSheet } from "./bottom-sheet.js";

const meta: Meta = {
  title: "Components/BottomSheet",
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <BottomSheet.Root>
      <BottomSheet.Trigger asChild>
        <Button>Open Bottom Sheet</Button>
      </BottomSheet.Trigger>
      <BottomSheet.Content>
        <BottomSheet.Header>
          <BottomSheet.Title>Select an Option</BottomSheet.Title>
          <BottomSheet.Description>
            Choose one of the actions below.
          </BottomSheet.Description>
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
  render: () => (
    <BottomSheet.Root>
      <BottomSheet.Trigger asChild>
        <Button variant="outlined">Share</Button>
      </BottomSheet.Trigger>
      <BottomSheet.Content>
        <BottomSheet.Header>
          <BottomSheet.Title icon={Share}>Share with</BottomSheet.Title>
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
