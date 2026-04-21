/**
 * POST /v1/conversations/:id/playground/compact
 *
 * Force-compact a conversation (dev-only playground). Wraps
 * `Conversation.forceCompact()` and returns the pre/post prompt-token
 * estimates plus the summary metadata so the playground UI can display
 * the delta.
 *
 * Guarded by `assertPlaygroundEnabled` — returns 404 when the
 * `compaction-playground` feature flag is off.
 */

import { estimatePromptTokens } from "../../../context/token-estimator.js";
import { httpError } from "../../http-errors.js";
import type { RouteDefinition } from "../../http-router.js";
import { assertPlaygroundEnabled, type PlaygroundRouteDeps } from "./index.js";

export function forceCompactRouteDefinitions(
  deps: PlaygroundRouteDeps,
): RouteDefinition[] {
  return [
    {
      endpoint: "conversations/:id/playground/compact",
      method: "POST",
      policyKey: "conversations/playground/compact",
      summary: "Force compaction on a conversation (dev-only playground)",
      tags: ["playground"],
      handler: async ({ params }) => {
        const gate = assertPlaygroundEnabled(deps);
        if (gate) return gate;

        const conversation = deps.getConversationById(params.id);
        if (!conversation) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
        }

        const messagesBefore = conversation.getMessages();
        const previousTokens = estimatePromptTokens(messagesBefore);
        const result = await conversation.forceCompact();
        const messagesAfter = conversation.getMessages();
        const newTokens = estimatePromptTokens(messagesAfter);

        return Response.json({
          compacted: result.compacted,
          previousTokens,
          newTokens,
          summaryText: result.summaryText ?? null,
          messagesRemoved: result.compactedPersistedMessages ?? 0,
          summaryFailed: result.summaryFailed ?? null,
        });
      },
    },
  ];
}
