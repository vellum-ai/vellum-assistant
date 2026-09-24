/**
 * Emails in a sent bubble, after the composer chips have done their job. The
 * card takes the attachment square's tile and puts the caption beside it, so
 * a message that carried mail reads like one that carried files; the wash and
 * the first caption word say received or sent. Each card links back to its
 * message in the inbox.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { MemoryRouter } from "react-router";

import { MessageEmailReferences } from "@/domains/chat/components/chat-attachments/message-email-references";
import type { EmailReference } from "@/types/email-reference";

const EMAILS: EmailReference[] = [
  {
    id: "msg_in_1",
    direction: "inbound",
    from: { name: "Maya Chen", address: "maya@example.com" },
    to: [{ address: "velly@example.org" }],
    subject: "Q4 vendor contract",
    createdAt: "2026-09-16T09:52:00Z",
  },
  {
    id: "msg_out_1",
    direction: "outbound",
    from: { name: "Velly", address: "velly@example.org" },
    to: [{ name: "Sam Okafor", address: "sam@example.com" }],
    subject: "Re: Dinner on Saturday, and the thing about the car",
    createdAt: "2026-09-12T18:04:00Z",
  },
];

const meta: Meta<typeof MessageEmailReferences> = {
  title: "Chat/EmailReferenceCard",
  component: MessageEmailReferences,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof MessageEmailReferences>;

/** Two cards in a user bubble's surface, one of each direction. */
export const InBubble: Story = {
  render: () => (
    <div className="w-fit max-w-[520px] rounded-2xl bg-[var(--surface-lift)] p-4">
      <MessageEmailReferences emails={EMAILS} />
      <p className="mt-3 text-chat text-[var(--content-default)]">
        Can you summarise these two for me?
      </p>
    </div>
  ),
};
