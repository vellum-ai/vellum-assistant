/**
 * `question_request` SSE event.
 *
 * Server → client prompt asking the user one or a small batch (≤5) of
 * clarifying questions during a turn. Emitted by the question
 * prompter when the LLM calls `ask_question` (or its batched
 * equivalent).
 *
 * Resolved by a paired `interaction_resolved` event (`kind:
 * "question"`, `state: "answered" | "cancelled" | "superseded"`) once
 * the user submits answers, the daemon times out, or a newer user
 * message supersedes the pending request.
 *
 * Wire-compat:
 *
 *  - `questions[]` is the canonical batched shape new clients should
 *    consume. The whole batch is one card lifecycle on the client:
 *    one render, one state machine, one response submission. `id` on
 *    each entry is daemon-assigned (`q1`, `q2`, …) so the client has
 *    a stable handle to post the user's answer against.
 *
 *  - The flat `question` / `description` / `options` /
 *    `freeTextPlaceholder` fields mirror `questions[0]` for older
 *    clients that key off the flat shape. Daemon callers that don't
 *    supply a batch get a one-element `questions` array synthesized
 *    from the flat fields, so both shapes are populated on every
 *    broadcast. Once all clients consume `questions[]`, the flat
 *    fields can be dropped (separate cleanup).
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const QuestionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionEntrySchema = z.object({
  id: z.string(),
  question: z.string(),
  description: z.string().optional(),
  options: z.array(QuestionOptionSchema),
  freeTextPlaceholder: z.string().optional(),
});

export type QuestionEntry = z.infer<typeof QuestionEntrySchema>;

export const QuestionRequestEventSchema = z.object({
  type: z.literal("question_request"),
  requestId: z.string(),
  questions: z.array(QuestionEntrySchema),
  question: z.string(),
  description: z.string().optional(),
  options: z.array(QuestionOptionSchema),
  freeTextPlaceholder: z.string().optional(),
  conversationId: z.string().optional(),
  toolUseId: z.string().optional(),
});

export type QuestionRequestEvent = z.infer<typeof QuestionRequestEventSchema>;
