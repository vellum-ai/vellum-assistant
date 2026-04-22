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

        // Per-conversation in-flight guard. `Conversation.processing` is set
        // to `true` whenever an agent turn or a slash-`/compact` is mid-flight
        // (see `conversation-routes.ts` and `Conversation.persistUserMessage`).
        // If we ran a second `forceCompact()` against the same conversation
        // while one was already in progress, we would race and double up
        // `contextCompactedMessageCount`, emit duplicate `context_compacted`
        // SSE events, and double-record usage. Easy to trigger by
        // double-clicking the playground "Force Compact" button. Fail fast
        // with 409 — the playground is a debug tool and clobbering legitimate
        // in-flight processing is worse than a brief retryable error.
        if (conversation.processing) {
          return httpError(
            "CONFLICT",
            "Compaction already in progress for this conversation",
            409,
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
