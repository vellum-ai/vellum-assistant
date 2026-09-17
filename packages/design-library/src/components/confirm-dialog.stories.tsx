import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, screen, userEvent, waitFor } from "storybook/test";

import { Button } from "./button";
import { ConfirmDialog, type ConfirmDialogProps } from "./confirm-dialog";
import { Modal } from "./modal";

const meta: Meta<ConfirmDialogProps> = {
  title: "Components/ConfirmDialog",
  component: ConfirmDialog,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    title: { control: "text" },
    message: { control: "text" },
    error: { control: "text" },
    confirmLabel: { control: "text" },
    cancelLabel: { control: "text" },
    destructive: { control: "boolean" },
    confirmDisabled: { control: "boolean" },
    open: { control: false },
    onConfirm: { control: false },
    onCancel: { control: false },
    children: { control: false },
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

export const WithError: Story = {
  args: {
    title: "Skip today's credit limit?",
    message:
      "Your $25.00 daily limit won't apply for the rest of today. It comes back automatically at 6:00 PM MT.",
    error: "Could not skip today's limit. Please try again.",
    confirmLabel: "Skip for today",
  },
  render: function WithErrorStory(args) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open Failed Confirm</Button>
        <ConfirmDialog
          {...args}
          open={open}
          // The confirm has already been tried and rejected, so it leaves the
          // dialog open with the failure showing.
          onConfirm={() => {}}
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
/**
 * A confirmation asked from inside another modal answers only for itself.
 *
 * The two dialogs are separate layers, and the outer one is told about an
 * outside press on the click, after React has flushed. The confirmation has
 * closed itself by then, so its own button reads as a press outside the modal
 * behind it. Only the backdrop dismisses a modal, which is what keeps the
 * answer from taking the dialog that asked the question with it.
 */
export const InsideModal: Story = {
  args: {
    title: "Remove user@example.com?",
    message: "Are you sure?",
    confirmLabel: "Remove",
    destructive: true,
  },
  parameters: { controls: { disable: true } },
  render: function InsideModalStory(args) {
    const [open, setOpen] = useState(true);
    const [confirming, setConfirming] = useState(false);
    const [accounts, setAccounts] = useState([
      "notion-mcp",
      "user@example.com",
    ]);
    return (
      <Modal.Root open={open} onOpenChange={setOpen}>
        <Modal.Content size="md">
          <Modal.Header>
            <Modal.Title>Notion</Modal.Title>
          </Modal.Header>
          <Modal.Body className="flex flex-col items-start gap-3">
            <ul className="text-body-medium-default">
              {accounts.map((account) => (
                <li key={account}>{account}</li>
              ))}
            </ul>
            <Button variant="outlined" onClick={() => setConfirming(true)}>
              Remove an account
            </Button>
          </Modal.Body>
        </Modal.Content>
        <ConfirmDialog
          {...args}
          open={confirming}
          onConfirm={() => {
            setAccounts((rest) => rest.slice(0, -1));
            setConfirming(false);
          }}
          onCancel={() => setConfirming(false)}
        />
      </Modal.Root>
    );
  },
  play: async () => {
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove an account" }),
    );

    // Pressed and released, not clicked: the layer below is told about an
    // outside press on the click, and it is the press that arms that check.
    const confirm = await screen.findByRole("button", { name: "Remove" });
    fireEvent.pointerDown(confirm, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(confirm, { button: 0 });
    fireEvent.click(confirm, { button: 0 });

    // The question is answered, and the dialog that asked it is still open on
    // the account the answer left behind.
    await waitFor(() => {
      expect(screen.queryByText("Are you sure?")).toBeNull();
    });
    await expect(await screen.findByText("Notion")).toBeVisible();
    await expect(await screen.findByText("notion-mcp")).toBeVisible();
    expect(screen.queryByText("user@example.com")).toBeNull();
  },
};
