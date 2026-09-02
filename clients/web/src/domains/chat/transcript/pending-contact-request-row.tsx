/**
 * Renders a `ContactPromptCard` inline in the transcript by reading
 * interaction-store state directly — no render-prop relay from the parent.
 */

import {
  useInteractionStore,
  useSubmittingRequestId,
} from "@/domains/chat/interaction-store";
import {
  handleContactPromptSubmit,
  handleContactPromptCancel,
} from "@/domains/chat/contact-actions";
import { ContactPromptCard } from "@/domains/chat/components/contact-prompt-card";

export function PendingContactRequestRow() {
  const pendingContactRequest = useInteractionStore.use.pendingContactRequest();
  const submittingRequestId = useSubmittingRequestId("contactRequest");
  const accepted = useInteractionStore.use.contactRequestAccepted();

  if (!pendingContactRequest) {
    return null;
  }

  // This card's own submission, not any submission.
  const isSubmitting = submittingRequestId === pendingContactRequest.requestId;

  return (
    <ContactPromptCard
      // Remount per request so a replacement prompt starts with fresh state.
      key={pendingContactRequest.requestId}
      contactRequest={pendingContactRequest}
      isSubmitting={isSubmitting}
      accepted={accepted}
      onSubmit={handleContactPromptSubmit}
      onCancel={handleContactPromptCancel}
    />
  );
}
