/**
 * Renders a `ContactPromptCard` inline in the transcript by reading
 * interaction-store state directly — no render-prop relay from the parent.
 */

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useInteractionActions } from "@/domains/chat/hooks/use-interaction-actions";
import { ContactPromptCard } from "@/domains/chat/components/contact-prompt-card";

export function PendingContactRequestRow() {
  const pendingContactRequest = useInteractionStore.use.pendingContactRequest();
  const isSubmitting = useInteractionStore.use.isSubmittingContactRequest();
  const accepted = useInteractionStore.use.contactRequestAccepted();
  const { handleContactPromptSubmit, handleContactPromptCancel } = useInteractionActions();

  if (!pendingContactRequest) return null;

  return (
    <ContactPromptCard
      contactRequest={pendingContactRequest}
      isSubmitting={isSubmitting}
      accepted={accepted}
      onSubmit={handleContactPromptSubmit}
      onCancel={handleContactPromptCancel}
    />
  );
}
