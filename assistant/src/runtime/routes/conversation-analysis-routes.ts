/**
 * Route handler for conversation analysis.
 *
 * POST /v1/conversations/:id/analyze — analyze a conversation via a new
 * agent loop that produces a structured self-assessment.
 *
 * The heavy lifting lives in `services/analyze-conversation.ts`. This module
 * is thin glue: map the route params to the service, translate service
 * errors, and build the success response.
 */

import { analyzeConversation } from "../services/analyze-conversation.js";
import { buildConversationDetailResponse } from "../services/conversation-serializer.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleAnalyzeConversation({
  pathParams = {},
}: RouteHandlerArgs) {
  const conversationId = pathParams.id;
  if (!conversationId) {
    throw new BadRequestError("Conversation ID is required");
  }

  const result = await analyzeConversation(conversationId, {
    trigger: "manual",
  });

  if ("error" in result) {
    const { kind, message } = result.error;
    if (kind === "NOT_FOUND") throw new NotFoundError(message);
    if (kind === "BAD_REQUEST") throw new BadRequestError(message);
    throw new InternalError(message);
  }

  const detail = buildConversationDetailResponse(result.analysisConversationId);
  if (!detail) {
    throw new InternalError(
      `Analysis conversation ${result.analysisConversationId} could not be loaded`,
    );
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Transport-agnostic route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "analyzeConversation",
    endpoint: "conversations/:id/analyze",
    method: "POST",
    policyKey: "conversations/analyze",
    summary: "Analyze a conversation",
    description:
      "Create a new conversation with a structured self-assessment of an existing conversation.",
    tags: ["conversations"],
    handler: handleAnalyzeConversation,
  },
];
