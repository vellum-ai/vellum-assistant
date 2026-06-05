/**
 * Renders a `ConfirmationPromptCard` inline in the transcript by reading
 * interaction-store state directly — no render-prop relay from the parent.
 */

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useInteractionActions } from "@/domains/chat/hooks/use-interaction-actions";
import { ConfirmationPromptCard } from "@/domains/chat/components/confirmation-prompt-card";

export function PendingConfirmationRow() {
  const pendingConfirmation = useInteractionStore.use.pendingConfirmation();
  const isSubmitting = useInteractionStore.use.isSubmittingConfirmation();
  const { handleConfirmationSubmit, handleAllowAndCreateRule } = useInteractionActions();

  if (!pendingConfirmation) return null;

  const showAllowAndCreateRule =
    pendingConfirmation.persistentDecisionsAllowed !== false &&
    (pendingConfirmation.allowlistOptions?.length ?? 0) > 0;

  return (
    <ConfirmationPromptCard
      confirmation={pendingConfirmation}
      isSubmitting={isSubmitting}
      onSubmit={handleConfirmationSubmit}
      onAllowAndCreateRule={showAllowAndCreateRule ? handleAllowAndCreateRule : undefined}
    />
  );
}
