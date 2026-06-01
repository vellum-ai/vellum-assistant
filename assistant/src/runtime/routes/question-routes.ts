/**
 * Route handler for resolving pending question prompts.
 *
 * POST /v1/question-response — a client (UI or remote channel) submits the
 * user's selection for a pending ask-question interaction registered by
 * {@link QuestionPrompter}. Two top-level shapes are accepted:
 *
 *  - `kind: "submit"` carries a `responses` array — one entry per question in
 *    the original batch. The web client builds this locally and POSTs it once
 *    the user is done revising the card.
 *  - `kind: "close"` records that the user dismissed the card without
 *    answering; every entry is reported as `skipped`.
 *
 * For backwards-compat we also accept the prior single-question shape
 * (`{ kind: "option" | "free_text", ... }`) as syntactic sugar for a
 * one-element batch. That branch only succeeds against a single-question
 * batch — multi-question batches reject it with a helpful error.
 *
 * Cross-talk safety: pending interactions of other kinds (`confirmation`,
 * `secret`, host_*, etc.) return 404 here rather than being mis-resolved.
 */
import { z } from "zod";

import {
  buildBatchEntries,
  type QuestionBatchMetadata,
  type QuestionBatchSubmission,
  QuestionBatchValidationError,
  type QuestionPromptResult,
} from "../../permissions/question-prompter.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import * as pendingInteractions from "../pending-interactions.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("question-routes");

// ── Batched (current) body shape ────────────────────────────────────

const SubmitEntry = z.discriminatedUnion("kind", [
  z.object({
    questionId: z.string(),
    kind: z.literal("option"),
    optionId: z.string(),
  }),
  z.object({
    questionId: z.string(),
    kind: z.literal("free_text"),
    text: z.string(),
  }),
  z.object({
    questionId: z.string(),
    kind: z.literal("skip"),
  }),
]);

const SubmitBody = z.object({
  requestId: z.string(),
  kind: z.literal("submit"),
  responses: z.array(SubmitEntry).min(1),
});

const CloseBody = z.object({
  requestId: z.string(),
  kind: z.literal("close"),
});

// ── Legacy single-question body shape (sugar for one-element batch) ──

const LegacyOptionBody = z.object({
  requestId: z.string(),
  kind: z.literal("option"),
  optionId: z.string(),
});

const LegacyFreeTextBody = z.object({
  requestId: z.string(),
  kind: z.literal("free_text"),
  text: z.string(),
});

// All four variants are mutually exclusive by their `kind` literal, so use
// `discriminatedUnion` rather than plain `union`. The generated OpenAPI then
// emits `oneOf` for the body (matching the pre-batched-shape spec) instead
// of the looser `anyOf` that `z.union` produces.
const QuestionResponseBody = z.discriminatedUnion("kind", [
  SubmitBody,
  CloseBody,
  LegacyOptionBody,
  LegacyFreeTextBody,
]);

type SubmitBody = z.infer<typeof SubmitBody>;
type CloseBody = z.infer<typeof CloseBody>;
type LegacyOptionBody = z.infer<typeof LegacyOptionBody>;
type LegacyFreeTextBody = z.infer<typeof LegacyFreeTextBody>;
type QuestionResponseBody = z.infer<typeof QuestionResponseBody>;

/**
 * POST /v1/question-response — resolve a pending ask-question interaction.
 */
function handleQuestionResponse({ body }: RouteHandlerArgs) {
  const parsed = QuestionResponseBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid question response body: ${parsed.error.message}`,
    );
  }

  const response: QuestionResponseBody = parsed.data;
  const { requestId } = response;

  const interaction = pendingInteractions.get(requestId);
  if (!interaction || interaction.kind !== "question") {
    log.warn(
      { requestId, foundKind: interaction?.kind },
      "Question response for unknown or wrong-kind requestId",
    );
    throw new NotFoundError(
      "No pending question interaction found for this requestId",
    );
  }

  // Build + validate the result BEFORE touching `pendingInteractions`, so a
  // bad payload leaves the pending interaction (and its timer) intact and the
  // user gets another chance to submit a correct batch.
  let result: QuestionPromptResult;
  try {
    if (response.kind === "close") {
      const { orderedIds } = readBatchMetadata(interaction);
      result = {
        entries: orderedIds.map((id) => ({
          questionId: id,
          decision: "skipped" as const,
        })),
        overall: "closed",
      };
    } else {
      const submissions = buildSubmissions(response, interaction);
      result = buildCompletedResult(submissions, interaction);
    }
  } catch (err) {
    if (err instanceof QuestionBatchValidationError) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }

  // Validation passed — deregister now to clear the prompter timer, then
  // hand the result to the prompter's caller via rpcResolve.
  pendingInteractions.resolve(
    requestId,
    response.kind === "close" ? "cancelled" : "answered",
  );

  log.info(
    {
      requestId,
      overall: result.overall,
      conversationId: interaction.conversationId,
    },
    "Question resolved",
  );

  (interaction.rpcResolve as
    | ((value: QuestionPromptResult) => void)
    | undefined)?.(result);

  return { success: true };
}

/**
 * Normalize the incoming body to a `QuestionBatchSubmission[]` for the
 * submit/legacy paths. Returns `null` for the `close` path (no submissions).
 */
function buildSubmissions(
  body: SubmitBody | LegacyOptionBody | LegacyFreeTextBody,
  interaction: ReturnType<typeof pendingInteractions.get>,
): QuestionBatchSubmission[] {
  if (body.kind === "submit") return body.responses;

  // Legacy single-question shim: synthesize a one-element batch. The
  // prompter stashed the ordered ids on the interaction metadata so we can
  // pick the (single) target questionId here.
  const { orderedIds } = readBatchMetadata(interaction);
  if (orderedIds.length === 0) {
    throw new QuestionBatchValidationError(
      "Legacy single-question payload requires a registered batch with at least one question",
    );
  }
  if (orderedIds.length > 1) {
    throw new QuestionBatchValidationError(
      'Legacy single-question payload cannot answer a multi-question batch; submit `{ kind: "submit", responses: [...] }` covering every question instead.',
    );
  }
  const questionId = orderedIds[0]!;
  if (body.kind === "option") {
    return [{ questionId, kind: "option", optionId: body.optionId }];
  }
  return [{ questionId, kind: "free_text", text: body.text }];
}

/**
 * Build a `completed` QuestionPromptResult from a batched submission and the
 * per-question metadata the prompter stashed on the interaction. Delegates
 * the validation + ordering loop to {@link buildBatchEntries} so the
 * prompter and the route share a single implementation.
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
function readBatchMetadata(
  interaction: ReturnType<typeof pendingInteractions.get>,
): QuestionBatchMetadata {
  const meta = interaction?.metadata as Partial<QuestionBatchMetadata> | undefined;
  return {
    orderedIds: meta?.orderedIds ?? [],
    optionsById: meta?.optionsById ?? {},
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "question_response",
    endpoint: "question-response",
    method: "POST",
    policy: {
      requiredScopes: ["approval.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleQuestionResponse,
    requireGuardian: true,
    summary: "Resolve a pending ask-question prompt",
    description:
      "Submit the user's batched response (or close the card) for a pending question prompt by requestId. Legacy single-question payloads remain accepted as syntactic sugar for a one-element batch.",
    tags: ["approvals"],
    requestBody: QuestionResponseBody,
    responseBody: z.object({
      success: z.boolean(),
    }),
  },
];
