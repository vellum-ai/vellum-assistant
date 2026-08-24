/**
 * Renders a `ConfirmationPromptCard` inline in the transcript by reading
 * interaction-store state directly — no render-prop relay from the parent.
 */

import {
  useInteractionStore,
  useSubmittingRequestId,
} from "@/domains/chat/interaction-store";
import {
  handleConfirmationSubmit,
  handleAllowAndCreateRule,
} from "@/domains/chat/confirmation-actions";
import { ConfirmationPromptCard } from "@/domains/chat/components/confirmation-prompt-card";

export function PendingConfirmationRow() {
  const pendingConfirmation = useInteractionStore.use.pendingConfirmation();
  const submittingRequestId = useSubmittingRequestId("confirmation");

  if (!pendingConfirmation) {
    return null;
  }

  // This card's own submission, not any submission: the spinner belongs to the
  // prompt being answered rather than to whatever happens to be on the wire.
  const isSubmitting = submittingRequestId === pendingConfirmation.requestId;

  // The card owns whether the rule option is offered; this only says the
  // surface can act on it.
  return (
    <ConfirmationPromptCard
      confirmation={pendingConfirmation}
      isSubmitting={isSubmitting}
      onSubmit={handleConfirmationSubmit}
      onAllowAndCreateRule={handleAllowAndCreateRule}
    />
  );
}
