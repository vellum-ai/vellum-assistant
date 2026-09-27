/**
 * Inbox emails staged in the composer strip. The chip sits beside file and
 * folder chips, so it borrows their shape; what is its own is the direction,
 * said by the glyph's wash and in words on the second line, so a received
 * message and a sent one never read alike. Check the long subject and the
 * missing subject, and the strip at the composer's width.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import type { EmailReferenceAttachment } from "@/domains/chat/composer-store";
import { EmailReferenceChip } from "@/domains/chat/components/chat-attachments/email-reference-chip";

const TODAY = new Date();
TODAY.setHours(9, 52, 0, 0);

const STAGED: EmailReferenceAttachment[] = [
  {
    kind: "email-reference",
    localId: "att-1",
    email: {
      id: "msg_in_1",
      direction: "inbound",
      from: { name: "Maya Chen", address: "maya@example.com" },
      to: [{ address: "velly@example.org" }],
      subject: "Q4 vendor contract",
      createdAt: TODAY.toISOString(),
    },
  },
  {
    kind: "email-reference",
    localId: "att-2",
    email: {
      id: "msg_out_1",
      direction: "outbound",
      from: { name: "Velly", address: "velly@example.org" },
      to: [{ name: "Sam Okafor", address: "sam@example.com" }],
      subject: "Re: Dinner on Saturday, and the thing about the car",
      createdAt: "2026-09-12T18:04:00Z",
    },
  },
  {
    kind: "email-reference",
    localId: "att-3",
    email: {
      id: "msg_in_2",
      direction: "inbound",
      from: { address: "no-reply@example.net" },
      to: [{ address: "velly@example.org" }],
      subject: "",
      createdAt: "2026-09-10T07:00:00Z",
    },
  },
];

const meta: Meta<typeof EmailReferenceChip> = {
  title: "Chat/EmailReferenceChip",
  component: EmailReferenceChip,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof EmailReferenceChip>;

/** One received message, sent today, so the date shows as a time. */
export const Received: Story = {
  args: { attachment: STAGED[0]!, onRemove: fn().mockName("onRemove") },
};

/** One sent message with a subject long enough to truncate. */
export const Sent: Story = {
  args: { attachment: STAGED[1]!, onRemove: fn().mockName("onRemove") },
};

/** The strip as the composer draws it: received, sent, and a mail with no subject. */
export const InStrip: Story = {
  render: () => (
    <div className="flex max-w-[560px] gap-2 overflow-x-auto rounded-2xl bg-[var(--surface-lift)] px-3 py-2 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
      {STAGED.map((attachment) => (
        <EmailReferenceChip
          key={attachment.localId}
          attachment={attachment}
          onRemove={fn().mockName("onRemove")}
        />
      ))}
    </div>
  ),
};
