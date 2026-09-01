import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { Conversation } from "@/types/conversation-types";
import { Button } from "@vellumai/design-library";

import { DeleteConversationConfirmDialog } from "./delete-conversation-confirm-dialog";

const CONVERSATION = {
  conversationId: "conv-xyz",
  title: "Planning notes",
} as Conversation;

const meta: Meta<typeof DeleteConversationConfirmDialog> = {
  title: "Chat/DeleteConversationConfirmDialog",
  component: DeleteConversationConfirmDialog,
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof DeleteConversationConfirmDialog>;

export const Default: Story = {
  render: function Render() {
    const [pending, setPending] = useState<Conversation | null>(CONVERSATION);
    return (
      <>
        <Button variant="danger" onClick={() => setPending(CONVERSATION)}>
          Delete conversation
        </Button>
        <DeleteConversationConfirmDialog
          pending={pending}
          onConfirm={() => setPending(null)}
          onCancel={() => setPending(null)}
        />
      </>
    );
  },
};
