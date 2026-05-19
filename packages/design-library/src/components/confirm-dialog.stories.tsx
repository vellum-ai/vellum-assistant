import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";
import { ConfirmDialog } from "./confirm-dialog.js";

const meta: Meta = {
  title: "Components/ConfirmDialog",
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: function DefaultStory() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open Confirm</Button>
        <ConfirmDialog
          open={open}
          title="Confirm Action"
          message="Are you sure you want to proceed? This action cannot be undone."
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
};

export const Destructive: Story = {
  render: function DestructiveStory() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete Item
        </Button>
        <ConfirmDialog
          open={open}
          title="Delete Item"
          message="This will permanently delete this item. This action cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Keep"
          destructive
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
};

export const CustomLabels: Story = {
  render: function CustomLabelsStory() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="outlined" onClick={() => setOpen(true)}>
          Publish Draft
        </Button>
        <ConfirmDialog
          open={open}
          title="Publish Draft"
          message="Publishing will make this content visible to all users."
          confirmLabel="Publish Now"
          cancelLabel="Not Yet"
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
};
