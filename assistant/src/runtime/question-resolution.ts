/**
 * Shared resolution core for pending `ask_question` interactions.
 *
 * A pending `question` interaction (registered by {@link QuestionPrompter}) can
 * be resolved from two places:
 *
 *  - `POST /v1/question-response` — an app/web client submits the user's
 *    batched selection (see `routes/question-routes.ts`).
 *  - the guardian-request pipeline — a channel option tap, request-code reply,
 *    or bare-text answer routes through the guardian reply router to the
 *    `pending_question` resolver, which builds the submission (see
 *    `approvals/guardian-request-resolvers.ts`).
 *
 * Both funnel through {@link resolvePendingQuestion} so the validate → consume
 * → `rpcResolve` sequence has a single implementation. The helper is
 * transport-agnostic: it returns a discriminated outcome rather than throwing
 * route errors, so each caller maps the outcome to its own surface (HTTP status
 * codes for the route; a resolver failure reason for the pipeline).
 */

import {
  buildBatchEntries,
  type QuestionBatchMetadata,
  type QuestionBatchSubmission,
  QuestionBatchValidationError,
  type QuestionPromptResult,
} from "../permissions/question-prompter.js";
import * as pendingInteractions from "./pending-interactions.js";

/**
 * How to resolve a pending question: a batched submission (one entry per
 * question) or a close (every question reported as `skipped`).
 */
export type QuestionResolutionInput =
  | { kind: "submit"; submissions: QuestionBatchSubmission[] }
  | { kind: "close" };

/**
 * Outcome of {@link resolvePendingQuestion}.
 *
 *  - `resolved` — the interaction was consumed and the prompter's caller
 *    settled. `conversationId` is the owning conversation (absent for
 *    conversation-less prompts).
 *  - `not_found` — no pending `question` interaction matched the requestId
 *    (already answered, timed out, superseded, or wrong kind). Callers treat
 *    this as a stale request.
 *  - `invalid` — the submission failed validation. The interaction is left
 *    intact (timer still running) so the user can submit a correct batch.
 */
export type QuestionResolutionOutcome =
  | {
      status: "resolved";
      result: QuestionPromptResult;
      conversationId?: string;
    }
  | { status: "not_found" }
  | { status: "invalid"; message: string };

/**
 * Resolve a pending `question` interaction with a batched submission or a
 * close. Validation runs BEFORE the interaction is consumed, so an `invalid`
 * outcome leaves the pending prompt (and its timer) intact for a retry.
 */
export function resolvePendingQuestion(
  requestId: string,
  input: QuestionResolutionInput,
): QuestionResolutionOutcome {
  const interaction = pendingInteractions.get(requestId);
  if (!interaction || interaction.kind !== "question") {
    return { status: "not_found" };
  }

  let result: QuestionPromptResult;
  try {
    if (input.kind === "close") {
      const { orderedIds } = readBatchMetadata(interaction);
      result = {
        entries: orderedIds.map((id) => ({
          questionId: id,
          decision: "skipped" as const,
        })),
        overall: "closed",
      };
    } else {
      result = buildCompletedResult(input.submissions, interaction);
    }
  } catch (err) {
    if (err instanceof QuestionBatchValidationError) {
      return { status: "invalid", message: err.message };
    }
    throw err;
  }

  // Validation passed — deregister now to clear the prompter timer, then hand
  // the result to the prompter's caller via rpcResolve.
  pendingInteractions.resolve(
    requestId,
    input.kind === "close" ? "cancelled" : "answered",
  );

  (
    interaction.rpcResolve as
      | ((value: QuestionPromptResult) => void)
      | undefined
  )?.(result);

  return {
    status: "resolved",
    result,
    conversationId: interaction.conversationId,
  };
}

/**
 * Build a `completed` QuestionPromptResult from a batched submission and the
 * per-question metadata the prompter stashed on the interaction. Delegates the
 * validation + ordering loop to {@link buildBatchEntries} so the prompter, the
 * route, and the channel wizard share a single implementation.
 */
function buildCompletedResult(
  submissions: QuestionBatchSubmission[],
  interaction: ReturnType<typeof pendingInteractions.get>,
): QuestionPromptResult {
  const { orderedIds, optionsById } = readBatchMetadata(interaction);
  if (orderedIds.length === 0) {
    throw new QuestionBatchValidationError(
      "No registered question ids for this batch",
    );
  }
  const entries = buildBatchEntries(
    orderedIds,
    (qid, oid) => (optionsById[qid] ?? []).includes(oid),
    new Set(Object.keys(optionsById)),
    submissions,
  );
  return { entries, overall: "completed" };
}

/**
 * Pull the prompter-stashed batch bookkeeping off a pending interaction.
 * Returns empty defaults if the metadata is absent.
 */
export function readBatchMetadata(
  interaction: ReturnType<typeof pendingInteractions.get>,
): QuestionBatchMetadata {
  const meta = interaction?.metadata as
    | Partial<QuestionBatchMetadata>
    | undefined;
  return {
    orderedIds: meta?.orderedIds ?? [],
    optionsById: meta?.optionsById ?? {},
  };
}
