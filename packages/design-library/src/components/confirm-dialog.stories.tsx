import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button";
import { ConfirmDialog, type ConfirmDialogProps } from "./confirm-dialog";

const meta: Meta<ConfirmDialogProps> = {
  title: "Components/ConfirmDialog",
  component: ConfirmDialog,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    title: { control: "text" },
    message: { control: "text" },
    confirmLabel: { control: "text" },
    cancelLabel: { control: "text" },
    destructive: { control: "boolean" },
    open: { control: false },
    onConfirm: { control: false },
    onCancel: { control: false },
  },
};

export default meta;
type Story = StoryObj<ConfirmDialogProps>;

export const Default: Story = {
  args: {
    title: "Confirm Action",
    message:
      "Are you sure you want to proceed? This action cannot be undone.",
  },
  render: function DefaultStory(args) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open Confirm</Button>
        <ConfirmDialog
          {...args}
          open={open}
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
};

export const Destructive: Story = {
  args: {
    title: "Delete Item",
    message:
      "This will permanently delete this item. This action cannot be undone.",
    confirmLabel: "Delete",
    cancelLabel: "Keep",
    destructive: true,
  },
  render: function DestructiveStory(args) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete Item
        </Button>
        <ConfirmDialog
          {...args}
          open={open}
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
};

export const CustomLabels: Story = {
  args: {
    title: "Publish Draft",
    message: "Publishing will make this content visible to all users.",
    confirmLabel: "Publish Now",
    cancelLabel: "Not Yet",
  },
  render: function CustomLabelsStory(args) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="outlined" onClick={() => setOpen(true)}>
          Publish Draft
        </Button>
        <ConfirmDialog
          {...args}
          open={open}
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
};
