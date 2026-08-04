/**
 * Read-only transcript record of an `ask_question` prompt the user answered.
 *
 * The interactive `QuestionPromptCard` lives above the composer and exists only
 * while the prompt is outstanding. This card is what the conversation keeps:
 * it renders from the `answeredQuestion` record the daemon persists on the
 * `ask_question` tool call, so the question and the user's choice stay readable
 * after switching conversations, reloading, or reopening from history.
 */

import type { AnsweredQuestion } from "@vellumai/assistant-api";
import {
  hasRenderableAnswer,
  resolveAnswers,
} from "@/domains/chat/answered-question";
import { AnsweredQuestionRow } from "@/domains/chat/components/answered-question-row";
import { Card, Typography } from "@vellumai/design-library";

export interface AnsweredQuestionCardProps {
  answered: AnsweredQuestion;
}

export function AnsweredQuestionCard({ answered }: AnsweredQuestionCardProps) {
  if (!hasRenderableAnswer(answered)) {
    return null;
  }

  return (
    <Card data-testid="answered-question-card">
      <div className="flex flex-col gap-3">
        {resolveAnswers(answered).map((item) => (
          <div key={item.questionId} className="flex flex-col gap-1.5">
            <Typography
              variant="body-medium-default"
              as="div"
              className="text-[color:var(--content-default)]"
            >
              {item.question}
            </Typography>
            {item.description && (
              <Typography
                variant="body-small-default"
                as="p"
                className="text-[color:var(--content-tertiary)]"
              >
                {item.description}
              </Typography>
            )}
            <AnsweredQuestionRow item={item} />
          </div>
        ))}
      </div>
    </Card>
  );
}
