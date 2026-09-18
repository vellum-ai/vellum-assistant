import { DesktopHelpCard } from "@/domains/chat/desktop/desktop-help-card";
import { getDesktopHelpEntry } from "@/domains/chat/desktop/desktop-help";
import {
  useInteractionStore,
  useSubmittingRequestId,
} from "@/domains/chat/interaction-store";
import { handleQuestionResponse } from "@/domains/chat/question-actions";

export function PendingDesktopHelpRow({ requestId }: { requestId: string }) {
  const question = useInteractionStore.use.pendingQuestion();
  const submittingRequestId = useSubmittingRequestId("question");
  const entry = getDesktopHelpEntry(question);
  if (!entry || question?.requestId !== requestId) {
    return null;
  }
  return (
    <DesktopHelpCard
      entry={entry}
      isSubmitting={submittingRequestId === requestId}
      onSubmit={handleQuestionResponse}
    />
  );
}
