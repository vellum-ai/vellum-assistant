/**
 * Renders a `SecretPromptCard` inline in the transcript by reading
 * interaction-store state directly — no render-prop relay from the parent.
 */

import {
  useInteractionStore,
  useSubmittingRequestId,
} from "@/domains/chat/interaction-store";
import {
  handleSecretSubmit,
  handleSecretCancel,
} from "@/domains/chat/secret-actions";
import { SecretPromptCard } from "@/domains/chat/components/secret-prompt-card";

export function PendingSecretRow() {
  const pendingSecret = useInteractionStore.use.pendingSecret();
  const submittingRequestId = useSubmittingRequestId("secret");
  const saved = useInteractionStore.use.secretSaved();

  if (!pendingSecret) {
    return null;
  }

  // This card's own submission, not any submission.
  const isSubmitting = submittingRequestId === pendingSecret.requestId;

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
