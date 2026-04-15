/**
 * Route handler for conversation analysis.
 *
 * POST /v1/conversations/:id/analyze — analyze a conversation via a new
 * agent loop that produces a structured self-assessment.
 *
 * The heavy lifting lives in `services/analyze-conversation.ts`. This module
 * is thin glue: map the route params to the service, translate service
 * errors into HTTP errors, and build the success response.
 */

import { httpError, type HttpErrorCode } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import {
  analyzeConversation,
  type ConversationAnalysisDeps,
} from "../services/analyze-conversation.js";

// Re-export the dependency type so existing callers can continue importing it
// from this module.
export type { ConversationAnalysisDeps };

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function conversationAnalysisRouteDefinitions(
  deps: ConversationAnalysisDeps,
): RouteDefinition[] {
  return [
    {
      endpoint: "conversations/:id/analyze",
      method: "POST",
      policyKey: "conversations/analyze",
      summary: "Analyze a conversation",
      description:
        "Create a new conversation with a structured self-assessment of an existing conversation.",
      tags: ["conversations"],
      handler: async ({ params }) => {
        const result = await analyzeConversation(params.id, deps, {
          trigger: "manual",
        });

        if ("error" in result) {
          return httpError(
            result.error.kind as HttpErrorCode,
            result.error.message,
            result.error.status,
          );
        }

        const detail = deps.buildConversationDetailResponse(
          result.analysisConversationId,
        );
        if (!detail) {
          return httpError(
            "INTERNAL_ERROR",
            `Analysis conversation ${result.analysisConversationId} could not be loaded`,
            500,
          );
        }
        return Response.json(detail);
      },
    },
  ];
}
