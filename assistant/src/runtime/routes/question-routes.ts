/**
 * Route handler for resolving pending question prompts.
 *
 * POST /v1/question-response — a client (UI or remote channel) submits the
 * user's selection (one of the supplied options, or free-text) for a pending
 * ask-question interaction registered by {@link QuestionPrompter}.
 *
 * Mirrors `/v1/confirm` and `/v1/secret`: the request body is validated via
 * zod, the pending interaction is looked up from the shared
 * `pendingInteractions` map, and the caller's Promise is resolved with the
 * appropriate `QuestionPromptResult` shape.
 *
 * Cross-talk safety: pending interactions of other kinds (`confirmation`,
 * `secret`, host_*, etc.) return 404 here rather than being mis-resolved.
 */
import { z } from "zod";

import type { QuestionPromptResult } from "../../permissions/question-prompter.js";
import { getLogger } from "../../util/logger.js";
import * as pendingInteractions from "../pending-interactions.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("question-routes");

const QuestionResponseBody = z.discriminatedUnion("kind", [
  z.object({
    requestId: z.string(),
    kind: z.literal("option"),
    optionId: z.string(),
  }),
  z.object({
    requestId: z.string(),
    kind: z.literal("free_text"),
    text: z.string(),
  }),
]);

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

  // Deregister now that we know we'll resolve — clears the prompter timer.
  pendingInteractions.resolve(requestId);

  const result: QuestionPromptResult =
    response.kind === "option"
      ? { decision: "option", optionId: response.optionId }
      : { decision: "free_text", text: response.text };

  log.info(
    {
      requestId,
      decision: result.decision,
      conversationId: interaction.conversationId,
    },
    "Question resolved",
  );

  (interaction.rpcResolve as
    | ((value: QuestionPromptResult) => void)
    | undefined)?.(result);

  return { success: true };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "question_response",
    endpoint: "question-response",
    method: "POST",
    handler: handleQuestionResponse,
    requireGuardian: true,
    summary: "Resolve a pending ask-question prompt",
    description:
      "Submit the user's response (option selection or free-text) for a pending question prompt by requestId.",
    tags: ["approvals"],
    requestBody: QuestionResponseBody,
    responseBody: z.object({
      success: z.boolean(),
    }),
  },
];
