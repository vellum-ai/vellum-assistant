import type { Meta, StoryObj } from "@storybook/react-vite";
import { Share, X } from "lucide-react";

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
 * An action sheet that announces itself: `Grabber` draws the pill at the top
 * edge, and the header pairs a quiet title with an explicit close control
 * rather than relying on the overlay alone. `padded={false}` lets each band
 * carry its own spacing, so the sheet owns its safe-area allowance.
 */
export const WithGrabber: Story = {
  args: {
    triggerLabel: "Open action sheet",
    title: "Conversation Actions",
    description: "",
    showIcon: false,
  },
  render: ({ triggerLabel, title, description, showIcon }) => (
    <BottomSheet.Root>
      <BottomSheet.Trigger asChild>
        <Button>{triggerLabel}</Button>
      </BottomSheet.Trigger>
      <BottomSheet.Content
        padded={false}
        className="pt-2 pb-[calc(24px+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]"
        aria-describedby={undefined}
      >
        <BottomSheet.Grabber />
        <BottomSheet.Header className="flex-row items-center justify-between gap-2 px-4 pt-3 pb-2">
          <BottomSheet.Title
            icon={showIcon ? Share : undefined}
            className="text-body-large-default text-[var(--content-tertiary)]"
          >
            {title}
          </BottomSheet.Title>
          {/* `outline-none` matters here rather than being boilerplate: Radix
              moves focus to the first focusable child on open, which is this
              button, and the user-agent outline would otherwise ring it every
              time the sheet appears. `keyboard-focus` is modality-aware, so a
              keyboard user still gets a ring and a tap does not. */}
          <BottomSheet.Close
            aria-label="Close"
            className="flex size-4 shrink-0 items-center justify-center text-[var(--content-tertiary)] outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]"
          >
            <X size={16} aria-hidden />
          </BottomSheet.Close>
        </BottomSheet.Header>
        <BottomSheet.Body className="px-4 pt-3">
          {description ? (
            <BottomSheet.Description className="mt-0 mb-3">
              {description}
            </BottomSheet.Description>
          ) : null}
          <div className="flex flex-col gap-2">
            <Button variant="ghost" className="justify-start">
              Rename
            </Button>
            <Button variant="ghost" className="justify-start">
              Archive
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
