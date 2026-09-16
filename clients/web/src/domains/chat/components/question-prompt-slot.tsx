/**
 * Renders the `QuestionPromptCard` above the composer when an agent question
 * is pending, reading state from interaction-store directly.
 */

import {
  useInteractionStore,
  useSubmittingRequestId,
} from "@/domains/chat/interaction-store";
import {
  handleQuestionResponse,
  handleDismissPendingQuestion,
} from "@/domains/chat/question-actions";
import { DesktopHelpCard } from "@/domains/chat/desktop/desktop-help-card";
import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card";

export function QuestionPromptSlot() {
  const pendingQuestion = useInteractionStore.use.pendingQuestion();
  const submittingRequestId = useSubmittingRequestId("question");

  if (!pendingQuestion) {
    return null;
  }

  // This card's own submission, not any submission.
  const isSubmitting = submittingRequestId === pendingQuestion.requestId;

  const desktopHelp =
    pendingQuestion.entries.length === 1 &&
    pendingQuestion.entries[0]?.presentation === "virtual_desktop"
      ? pendingQuestion.entries[0]
      : null;

  return (
    <div className="mb-2">
      {desktopHelp ? (
        <DesktopHelpCard
          key={pendingQuestion.requestId}
          entry={desktopHelp}
          isSubmitting={isSubmitting}
          onSubmit={handleQuestionResponse}
        />
      ) : (
        <QuestionPromptCard
          key={pendingQuestion.requestId}
          requestId={pendingQuestion.requestId}
          entries={pendingQuestion.entries}
          isSubmitting={isSubmitting}
          onSubmitAll={handleQuestionResponse}
          onClose={handleDismissPendingQuestion}
        />
      )}
    </div>
  );
}
