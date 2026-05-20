import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Settings } from "lucide-react";

import { Button } from "./button.js";
import { Modal } from "./modal.js";

const meta: Meta = {
  title: "Components/Modal",
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <Modal.Root>
      <Modal.Trigger asChild>
        <Button>Open Modal</Button>
      </Modal.Trigger>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>Modal Title</Modal.Title>
          <Modal.Description>
            This is a description of the modal content.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <p className="text-body-medium-default">
            Modal body content goes here.
          </p>
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
  render: () => (
    <Modal.Root>
      <Modal.Trigger asChild>
        <Button>Settings</Button>
      </Modal.Trigger>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title icon={Settings}>Preferences</Modal.Title>
          <Modal.Description>
            Configure your account preferences.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <p className="text-body-medium-default">Settings form content.</p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="outlined">Cancel</Button>
          </Modal.Close>
          <Button variant="primary">Save Changes</Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  ),
};

export const NoCloseButton: Story = {
  render: () => (
    <Modal.Root>
      <Modal.Trigger asChild>
        <Button>Open (no close button)</Button>
      </Modal.Trigger>
      <Modal.Content hideCloseButton>
        <Modal.Header>
          <Modal.Title>Confirm Action</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Modal.Description>
            This modal has no close button — dismiss via the footer buttons.
          </Modal.Description>
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
  render: function SizesStory() {
    const [size, setSize] = useState<"sm" | "md" | "lg" | "xl">("md");
    const [open, setOpen] = useState(false);

    return (
      <div className="flex gap-2">
        {(["sm", "md", "lg", "xl"] as const).map((s) => (
          <Button
            key={s}
            variant="outlined"
            size="compact"
            onClick={() => {
              setSize(s);
              setOpen(true);
            }}
          >
            {s}
          </Button>
        ))}
        <Modal.Root open={open} onOpenChange={setOpen}>
          <Modal.Content size={size}>
            <Modal.Header>
              <Modal.Title>Size: {size}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <p className="text-body-medium-default">
                This modal is using the &quot;{size}&quot; size preset.
              </p>
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
