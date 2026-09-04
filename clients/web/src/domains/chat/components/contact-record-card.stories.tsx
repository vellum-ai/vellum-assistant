import type { Meta, StoryObj } from "@storybook/react-vite";

import { TranscriptColumn } from "@/domains/chat/transcript/transcript-column";
import type { PendingContactRecordRequestState } from "@/types/interaction-ui-types";

import { ContactRecordCard } from "./contact-record-card";

/**
 * The guardian's answer to a contact record write the assistant proposed,
 * mounted in the transcript by `pending-contact-record-request-row`.
 *
 * One component covers all four operations, and the operation decides how much
 * of the card is a form: a create or an update seeds editable fields from the
 * proposal, while a delete drops the fields entirely and shows the channels
 * that are about to be lost. Nothing is written until the card is submitted.
 */
const meta: Meta<typeof ContactRecordCard> = {
  title: "Chat/ContactRecordCard",
  component: ContactRecordCard,
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
type Story = StoryObj<typeof ContactRecordCard>;

/**
 * A delete asks only for a confirmation, so there are no inputs: the heading
 * names the record, the warning says what else goes with it, and the channel
 * list is how the guardian tells two same-named contacts apart. The submit is
 * the danger variant.
 */
export const Delete: Story = {
  args: {
    request: {
      requestId: "req-contact-delete",
      operation: "delete",
      contactId: "contact-1",
      currentDisplayName: "Alice",
      channels: [{ type: "telegram", address: "+1-555-0142" }],
    } satisfies PendingContactRecordRequestState,
  },
};

/**
 * A create seeds the name and notes from the proposal and lets the guardian
 * edit both before anything is written. `label` and `description` are the
 * command's own framing for why the record is being proposed, and they replace
 * the generic "Add a contact" heading when present.
 */
export const Create: Story = {
  args: {
    request: {
      requestId: "req-contact-create",
      operation: "create",
      label: "Recreate Alice",
      description: "Fresh contact record for Alice, replacing the deleted one.",
      displayName: "Alice",
      notes:
        "Recreated after the earlier record was deleted. Email on file: user@example.com, carried over from the previous record.",
      notesProposed: true,
    } satisfies PendingContactRecordRequestState,
  },
};
