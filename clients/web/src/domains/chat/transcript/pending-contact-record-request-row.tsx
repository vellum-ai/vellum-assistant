/**
 * Renders a `ContactRecordCard` inline in the transcript by reading
 * interaction-store state directly, with no render-prop relay from the parent.
 */

import {
  useInteractionStore,
  useSubmittingRequestId,
} from "@/domains/chat/interaction-store";
import {
  handleContactRecordSubmit,
  handleContactRecordCancel,
} from "@/domains/chat/contact-actions";
import { ContactRecordCard } from "@/domains/chat/components/contact-record-card";

export function PendingContactRecordRequestRow() {
  const request = useInteractionStore.use.pendingContactRecordRequest();
  const submittingRequestId = useSubmittingRequestId("contactRecordRequest");
  const accepted = useInteractionStore.use.contactRecordRequestAccepted();

  if (!request) {
    return null;
  }

  // This card's own submission, not any submission.
  const isSubmitting = submittingRequestId === request.requestId;

  return (
    <ContactRecordCard
      // Remount per request so a replacement form starts with fresh state.
      key={request.requestId}
      request={request}
      isSubmitting={isSubmitting}
      accepted={accepted}
      onSubmit={handleContactRecordSubmit}
      onCancel={handleContactRecordCancel}
    />
  );
}
