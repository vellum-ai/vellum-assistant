/**
 * Pure projection of a persisted `answeredQuestion` record into the rows the
 * transcript renders.
 *
 * Kept out of the card component so the transcript can ask "is there an answer
 * to show?" without importing UI, and so the pairing rules below are testable
 * on their own.
 */

import type { AnsweredQuestion } from "@vellumai/assistant-api";

/** The rendered answer for one question, resolved against the options as asked. */
export interface ResolvedAnswer {
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
 * Whether an answered record has anything to show. A record with no questions
 * renders nothing, so a caller that hides the raw tool chip in favor of the
 * answered card must gate on this rather than on the field's presence: keying
 * off presence alone would leave a tool call rendering neither the card nor the
 * chip, dropping the step out of the transcript entirely. The daemon cannot
 * write an empty record (the prompter rejects an empty batch), but a truncated
 * or hand-edited persisted row satisfies the wire schema, which validates the
 * shape and not the arity.
 */
export function hasRenderableAnswer(
  answered: AnsweredQuestion | undefined,
): answered is AnsweredQuestion {
  return answered !== undefined && answered.questions.length > 0;
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
    // Blank free text means the user skipped. The card cannot submit an empty
    // answer (`handleSubmitFreeText` returns early on blank input), so the only
    // way one reaches here is the legacy single-question wire shape, which has
    // no `skip` kind and coerces a skip to `free_text` with empty text. Reading
    // it as free text would render a blank answer row.
    if (response?.decision === "free_text" && response.text?.trim()) {
      return {
        questionId: question.id,
        question: question.question,
        description: question.description,
        kind: "free_text",
        answer: response.text,
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
