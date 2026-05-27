import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Settings } from "lucide-react";

import { Button } from "./button";
import { Modal, type ModalSize } from "./modal";

interface ModalStoryArgs {
  size: ModalSize;
  hideCloseButton: boolean;
  title: string;
  description: string;
  body: string;
  showIcon: boolean;
}

const meta: Meta<ModalStoryArgs> = {
  title: "Components/Modal",
  parameters: {
    layout: "centered",
  },
  argTypes: {
    size: { control: "select", options: ["sm", "md", "lg", "xl"] },
    hideCloseButton: { control: "boolean" },
    title: { control: "text" },
    description: { control: "text" },
    body: { control: "text" },
    showIcon: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<ModalStoryArgs>;

export const Default: Story = {
  args: {
    size: "md",
    hideCloseButton: false,
    title: "Modal Title",
    description: "This is a description of the modal content.",
    body: "Modal body content goes here.",
    showIcon: false,
  },
  render: ({ size, hideCloseButton, title, description, body, showIcon }) => (
    <Modal.Root>
      <Modal.Trigger asChild>
        <Button>Open Modal</Button>
      </Modal.Trigger>
      <Modal.Content size={size} hideCloseButton={hideCloseButton}>
        <Modal.Header>
          <Modal.Title icon={showIcon ? Settings : undefined}>
            {title}
          </Modal.Title>
          {description ? (
            <Modal.Description>{description}</Modal.Description>
          ) : null}
        </Modal.Header>
        <Modal.Body>
          <p className="text-body-medium-default">{body}</p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="outlined">Cancel</Button>
          </Modal.Close>
          <Button variant="primary">Save</Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  ),
};

export const WithIcon: Story = {
  args: {
    size: "md",
    hideCloseButton: false,
    title: "Preferences",
    description: "Configure your account preferences.",
    body: "Settings form content.",
    showIcon: true,
  },
  render: Default.render,
};

export const NoCloseButton: Story = {
  args: {
    size: "md",
    hideCloseButton: true,
    title: "Confirm Action",
    description:
      "This modal has no close button — dismiss via the footer buttons.",
    body: "",
    showIcon: false,
  },
  render: ({ size, hideCloseButton, title, description, body, showIcon }) => (
    <Modal.Root>
      <Modal.Trigger asChild>
        <Button>Open (no close button)</Button>
      </Modal.Trigger>
      <Modal.Content size={size} hideCloseButton={hideCloseButton}>
        <Modal.Header>
          <Modal.Title icon={showIcon ? Settings : undefined}>
            {title}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {description ? (
            <Modal.Description>{description}</Modal.Description>
          ) : null}
          {body ? (
            <p className="text-body-medium-default">{body}</p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="outlined">Cancel</Button>
          </Modal.Close>
          <Button variant="primary">Confirm</Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  ),
};

export const Sizes: Story = {
  args: {
    size: "md",
    hideCloseButton: false,
    title: "Modal",
    description: "",
    body: "Click a button to open the modal at that size, or change the size control.",
    showIcon: false,
  },
  render: function SizesStory({ size, hideCloseButton, body, showIcon }) {
    const [activeSize, setActiveSize] = useState<ModalSize>(size);
    const [open, setOpen] = useState(false);

    return (
      <div className="flex gap-2">
        {(["sm", "md", "lg", "xl"] as const).map((s) => (
          <Button
            key={s}
            variant="outlined"
            size="compact"
            onClick={() => {
              setActiveSize(s);
              setOpen(true);
            }}
          >
            {s}
          </Button>
        ))}
        <Modal.Root open={open} onOpenChange={setOpen}>
          <Modal.Content size={activeSize} hideCloseButton={hideCloseButton}>
            <Modal.Header>
              <Modal.Title icon={showIcon ? Settings : undefined}>
                Size: {activeSize}
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <p className="text-body-medium-default">{body}</p>
            </Modal.Body>
            <Modal.Footer>
              <Modal.Close asChild>
                <Button variant="outlined">Close</Button>
              </Modal.Close>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      </div>
    );
  },
};
