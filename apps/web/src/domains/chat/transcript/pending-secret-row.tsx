/**
 * Renders a `SecretPromptCard` inline in the transcript by reading
 * interaction-store state directly — no render-prop relay from the parent.
 */

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useInteractionActions } from "@/domains/chat/hooks/use-interaction-actions";
import { SecretPromptCard } from "@/domains/chat/components/secret-prompt-card";

export function PendingSecretRow() {
  const pendingSecret = useInteractionStore.use.pendingSecret();
  const isSubmitting = useInteractionStore.use.isSubmittingSecret();
  const saved = useInteractionStore.use.secretSaved();
  const { handleSecretSubmit, handleSecretCancel } = useInteractionActions();

  if (!pendingSecret) return null;

  return (
    <SecretPromptCard
      secret={pendingSecret}
      isSubmitting={isSubmitting}
      saved={saved}
      onSave={(val) => handleSecretSubmit(val, "store")}
      onSendOnce={(val) => handleSecretSubmit(val, "transient_send")}
      onCancel={handleSecretCancel}
    />
  );
}
