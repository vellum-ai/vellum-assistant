/**
 * Renders the `QuestionPromptCard` above the composer when an agent question
 * is pending, reading state from interaction-store directly.
 */

import { Button, Notice } from "@vellumai/design-library";
import { useTranslation } from "@/i18n";

import {
  useInteractionStore,
  useSubmittingRequestId,
} from "@/domains/chat/interaction-store";
import {
  handleQuestionResponse,
  handleDismissPendingQuestion,
} from "@/domains/chat/question-actions";
import { getDesktopHelpEntry } from "@/domains/chat/desktop/desktop-help";
import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card";

export function QuestionPromptSlot({
  onViewConversation,
}: {
  onViewConversation?: () => void;
}) {
  const { t } = useTranslation("chat");
  const pendingQuestion = useInteractionStore.use.pendingQuestion();
  const submittingRequestId = useSubmittingRequestId("question");

  if (!pendingQuestion) {
    return null;
  }

  if (getDesktopHelpEntry(pendingQuestion)) {
    return onViewConversation ? (
      <div className="mb-2">
        <Notice
          tone="info"
          actions={
            <Button variant="ghost" size="compact" onClick={onViewConversation}>
              {t("documentChat.viewConversation")}
            </Button>
          }
        >
          {t("desktopHelpCard.needsHelp")}
        </Notice>
      </div>
    ) : null;
  }

  const isSubmitting = submittingRequestId === pendingQuestion.requestId;

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
