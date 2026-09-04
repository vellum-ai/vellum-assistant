import type { Meta, StoryObj } from "@storybook/react-vite";

import { TranscriptColumn } from "@/domains/chat/transcript/transcript-column";
import type { PendingContactRequestState } from "@/types/interaction-ui-types";

import { ContactPromptCard } from "./contact-prompt-card";

/**
 * The guardian's answer to a channel the assistant proposed binding to a
 * contact, mounted in the transcript by `pending-contact-request-row`.
 *
 * The address is editable because what the guardian submits is what gets
 * attested, not what the command proposed. The verify checkbox is theirs to
 * uncheck for the same reason: leaving it clear binds the address without
 * letting it message the assistant.
 */
const meta: Meta<typeof ContactPromptCard> = {
  title: "Chat/ContactPromptCard",
  component: ContactPromptCard,
  parameters: {
    layout: "padded",
  },
  args: {
    isSubmitting: false,
    accepted: false,
    onSubmit: () => {},
    onCancel: () => {},
  },
  decorators: [
    (Story) => (
      <TranscriptColumn>
        <Story />
      </TranscriptColumn>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ContactPromptCard>;

/**
 * Binding an email address to an existing contact. No name is proposed, so the
 * form is the address plus the verify choice; a request that also carries a
 * `displayName` adds an editable name field above the address.
 */
export const BindEmailAddress: Story = {
  args: {
    contactRequest: {
      requestId: "req-contact-channel",
      channel: "email",
      label: "Alice's email",
      description:
        "Binding user@example.com to recreate Alice's contact with a working email channel. This creates an address-named record that will be renamed right after.",
      defaultValue: "user@example.com",
      verify: true,
    } satisfies PendingContactRequestState,
  },
};
