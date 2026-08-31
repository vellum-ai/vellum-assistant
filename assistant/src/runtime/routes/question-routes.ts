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
 * Any assistant serving this route also accepts `submit`, so the shim serves
 * only clients that cannot tell which assistant they are talking to: a stale
 * browser bundle posts the single-question body against a batch-capable route.
 *
 * Cross-talk safety: pending interactions of other kinds (`confirmation`,
 * `secret`, host_*, etc.) return 404 here rather than being mis-resolved.
 *
 * Status ordering: a missing interaction is always 404, never a body-validation
 * 400, whichever shape was submitted. Clients treat 404 as the terminal signal
 * that retires a stale card, so a gone interaction reported as 400 would strand
 * the card and surface a validation string the user cannot act on.
 */
import { z } from "zod";

import {
  type QuestionBatchSubmission,
  QuestionBatchValidationError,
} from "../../permissions/question-prompter.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import * as pendingInteractions from "../pending-interactions.js";
import {
  readBatchMetadata,
  resolvePendingQuestion,
} from "../question-resolution.js";
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

  // Establish the interaction exists BEFORE normalizing the body. A missing or
  // wrong-kind interaction is not-found regardless of which body shape asked,
  // and the legacy shim below reads its stashed metadata: normalizing first
  // would surface a gone interaction as a body-validation 400, telling the
  // client its payload was malformed when the real answer is that there is
  // nothing left to answer. Clients rely on 404 being the terminal signal that
  // retires a stale card, so the status has to be right for every shape.
  // Peek, don't consume; `resolvePendingQuestion` performs the real consume.
  const interaction = pendingInteractions.get(requestId);
  if (!interaction || interaction.kind !== "question") {
    log.warn(
      { requestId },
      "Question response for unknown or wrong-kind requestId",
    );
    throw new NotFoundError(
      "No pending question interaction found for this requestId",
    );
  }

  let input;
  try {
    input =
      response.kind === "close"
        ? ({ kind: "close" } as const)
        : ({
            kind: "submit",
            submissions: buildSubmissions(response, interaction),
          } as const);
  } catch (err) {
    if (err instanceof QuestionBatchValidationError) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }

  const outcome = resolvePendingQuestion(requestId, input);

  // Still reachable: the interaction can be consumed between the peek above and
  // the resolve (a channel answer, a timeout firing).
  if (outcome.status === "not_found") {
    log.warn({ requestId }, "Question interaction resolved before submission");
    throw new NotFoundError(
      "No pending question interaction found for this requestId",
    );
  }
  if (outcome.status === "invalid") {
    throw new BadRequestError(outcome.message);
  }

  log.info(
    {
      requestId,
      overall: outcome.result.overall,
      conversationId: outcome.conversationId,
    },
    "Question resolved",
  );

  return { success: true };
}

/**
 * Normalize the incoming body to a `QuestionBatchSubmission[]` for the
 * submit/legacy paths.
 */
function buildSubmissions(
  body: SubmitBody | LegacyOptionBody | LegacyFreeTextBody,
  interaction: ReturnType<typeof pendingInteractions.get>,
): QuestionBatchSubmission[] {
  if (body.kind === "submit") {
    return body.responses;
  }

  // Legacy single-question shim: synthesize a one-element batch. The
  // prompter stashed the ordered ids on the interaction metadata so we can
  // pick the (single) target questionId here.
  const { orderedIds } = readBatchMetadata(interaction);
  // `QuestionPrompter` is the only registrar of a `question` interaction and
  // refuses an empty `questions` array, so this guard is unreachable.
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
