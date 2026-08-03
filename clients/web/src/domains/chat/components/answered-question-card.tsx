/**
 * Read-only transcript record of an `ask_question` prompt the user answered.
 *
 * The interactive `QuestionPromptCard` lives above the composer and exists only
 * while the prompt is outstanding. This card is what the conversation keeps:
 * it renders from the `answeredQuestion` record the daemon persists on the
 * `ask_question` tool call, so the question and the user's choice stay readable
 * after switching conversations, reloading, or reopening from history.
 */

import { Check, Pencil, SkipForward } from "lucide-react";

import type { AnsweredQuestion } from "@vellumai/assistant-api";
import { Card, Typography } from "@vellumai/design-library";

export interface AnsweredQuestionCardProps {
  answered: AnsweredQuestion;
}

/** The rendered answer for one question, resolved against the options as asked. */
interface ResolvedAnswer {
  questionId: string;
  question: string;
  description?: string;
  /** What the user chose, already resolved to display text. */
  answer: string;
  kind: "option" | "free_text" | "skipped";
  /** The chosen option's own description, when it had one. */
  answerDescription?: string;
}

/**
 * Pair each question with its response. Ordering follows `questions`, not
 * `responses`, so a record whose arrays disagree (a truncated or hand-edited
 * row) still renders every question rather than dropping the tail. A question
 * with no matching response reads as skipped, which is what an unanswered entry
 * in a settled batch means.
 */
export function resolveAnswers(answered: AnsweredQuestion): ResolvedAnswer[] {
  const byQuestionId = new Map(
    answered.responses.map((response) => [response.questionId, response]),
  );
  return answered.questions.map((question) => {
    const response = byQuestionId.get(question.id);
    if (response?.decision === "option") {
      const option = question.options.find(
        (candidate) => candidate.id === response.optionId,
      );
      return {
        questionId: question.id,
        question: question.question,
        description: question.description,
        kind: "option",
        // An unresolvable option id means the persisted record and the asked
        // options disagree; show the raw id rather than an empty row.
        answer: option?.label ?? response.optionId ?? "Unknown option",
        answerDescription: option?.description,
      };
    }
    if (response?.decision === "free_text") {
      return {
        questionId: question.id,
        question: question.question,
        description: question.description,
        kind: "free_text",
        answer: response.text ?? "",
      };
    }
    return {
      questionId: question.id,
      question: question.question,
      description: question.description,
      kind: "skipped",
      answer: "Skipped",
    };
  });
}

export function AnsweredQuestionCard({ answered }: AnsweredQuestionCardProps) {
  const resolved = resolveAnswers(answered);
  if (resolved.length === 0) {
    return null;
  }

  return (
    <Card data-testid="answered-question-card">
      <div className="flex flex-col gap-3">
        {resolved.map((item) => (
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
            <AnsweredRow item={item} />
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * One answer row. The leading glyph distinguishes the three shapes at a glance
 * and mirrors the interactive card's iconography: a check for a chosen option,
 * a pencil for typed text, a skip arrow for a question left unanswered.
 */
function AnsweredRow({ item }: { item: ResolvedAnswer }) {
  const Glyph =
    item.kind === "option"
      ? Check
      : item.kind === "free_text"
        ? Pencil
        : SkipForward;
  const isSkipped = item.kind === "skipped";
  return (
    <div className="flex items-start gap-2 rounded-md bg-[var(--surface-base)] px-3 py-2">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex shrink-0 items-center justify-center ${
          isSkipped
            ? "text-[color:var(--content-tertiary)]"
            : "text-[color:var(--primary-base)]"
        }`}
      >
        <Glyph className="h-3.5 w-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Typography
          variant="body-medium-default"
          as="span"
          className={
            isSkipped
              ? "text-[color:var(--content-tertiary)]"
              : "text-[color:var(--content-default)]"
          }
        >
          {item.answer}
        </Typography>
        {item.answerDescription && (
          <Typography
            variant="body-small-default"
            as="span"
            className="text-[color:var(--content-tertiary)]"
          >
            {item.answerDescription}
          </Typography>
        )}
      </span>
    </div>
  );
}
