/**
 * Renders the `QuestionPromptCard` above the composer when an agent question
 * is pending, reading state from interaction-store directly.
 */

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { handleQuestionResponse, handleDismissPendingQuestion } from "@/domains/chat/question-actions";
import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card";

export function QuestionPromptSlot() {
  const pendingQuestion = useInteractionStore.use.pendingQuestion();
  const isSubmitting = useInteractionStore.use.isSubmittingQuestion();

  if (!pendingQuestion) return null;

  return (
    <div className="mb-2">
      <QuestionPromptCard
        key={pendingQuestion.requestId}
        requestId={pendingQuestion.requestId}
        entries={pendingQuestion.entries}
        isSubmitting={isSubmitting}
        onSubmitAll={handleQuestionResponse}
        onClose={handleDismissPendingQuestion}
      />
    </div>
  );
}
