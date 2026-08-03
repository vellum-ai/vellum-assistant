/**
 * Durable record of an `ask_question` prompt the user has answered.
 *
 * The pending counterpart (`question_request` / `PendingToolQuestion`) is live
 * registry state: it exists only while the prompt is outstanding and vanishes
 * the moment the interaction resolves. This record is the opposite. It is
 * produced by the `ask_question` executor once the prompt settles, rides the
 * `tool_result` event, and is persisted on the tool_use block, so the answered
 * question and the user's choice stay readable in the transcript across
 * conversation switches, reloads, and history reopens.
 *
 * `questions` mirrors the `question_request` event's `questions[]` (same
 * daemon-assigned `q1`, `q2`, ... ids) so the answered card renders from the
 * same shape the interactive card did. `responses` is ordered to match, one
 * entry per question.
 *
 * Only user-driven outcomes are recorded: a completed batch, or a card the
 * user closed without answering (every question `skipped`). A prompt that
 * timed out or was aborted produced no user decision, so it carries no record
 * and the tool's own error result stands on its own.
 *
 * Canonical wire-contract source. Daemon code imports the type directly from
 * this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

import { QuestionEntrySchema } from "./question-request.js";

export const AnsweredQuestionResponseSchema = z.object({
  /** Daemon-assigned question id (`q1`, `q2`, ...) this answer belongs to. */
  questionId: z.string(),
  decision: z.enum(["option", "free_text", "skipped"]),
  /** Chosen option id. Present only when `decision` is `"option"`. */
  optionId: z.string().optional(),
  /** The user's typed answer. Present only when `decision` is `"free_text"`. */
  text: z.string().optional(),
});

export type AnsweredQuestionResponse = z.infer<
  typeof AnsweredQuestionResponseSchema
>;

export const AnsweredQuestionSchema = z.object({
  /** The resolved interaction's request id, matching the `question_request` that raised it. */
  requestId: z.string(),
  questions: z.array(QuestionEntrySchema),
  responses: z.array(AnsweredQuestionResponseSchema),
  /** `"completed"` when the user submitted a batch, `"closed"` when they dismissed the card. */
  overall: z.enum(["completed", "closed"]),
});

export type AnsweredQuestion = z.infer<typeof AnsweredQuestionSchema>;
