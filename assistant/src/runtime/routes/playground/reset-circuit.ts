/**
 * POST /v1/conversations/:id/playground/reset-compaction-circuit
 *
 * Dev-only playground endpoint that clears the compaction circuit-breaker
 * state on a live conversation. Intended for reproducing flows that normally
 * require three real summary-LLM failures to trigger — without this hatch,
 * exercising the "auto-compaction paused" banner requires bespoke fault
 * injection.
 *
 * Behavior:
 *   - `consecutiveCompactionFailures` is always zeroed.
 *   - `compactionCircuitOpenUntil` is cleared to null only when it was set;
 *     the `compaction_circuit_closed` event is emitted on the open→closed
 *     transition so the Swift banner dismisses immediately, mirroring the
 *     behavior of a successful compaction in `trackCompactionOutcome()`.
 *     Calling this endpoint while the breaker is already closed is a no-op
 *     on the event channel — it never emits a redundant close event.
 *
 * Guarded by `assertPlaygroundEnabled()` — the route 404s when the
 * `compaction-playground` feature flag is disabled, so the entire surface
 * is invisible in production.
 */

import { getConfig } from "../../../config/loader.js";
import { estimatePromptTokens } from "../../../context/token-estimator.js";
import type { Conversation } from "../../../daemon/conversation.js";
import { httpError } from "../../http-errors.js";
import type { RouteDefinition } from "../../http-router.js";
// Import directly from the source modules (not ./index.js) — index.ts imports
// this file's `resetCircuitRouteDefinitions`, so pulling its re-exports back
// through the barrel would create a cycle.
import type { PlaygroundRouteDeps } from "./deps.js";
import { assertPlaygroundEnabled } from "./guard.js";

export function resetCircuitRouteDefinitions(
  deps: PlaygroundRouteDeps,
): RouteDefinition[] {
  return [
    {
      endpoint: "conversations/:id/playground/reset-compaction-circuit",
      method: "POST",
      policyKey: "conversations/playground/reset-circuit",
      summary: "Clear compaction circuit-breaker state (dev-only playground)",
      tags: ["playground"],
      handler: ({ params }) => {
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

        conversation.consecutiveCompactionFailures = 0;
        if (conversation.compactionCircuitOpenUntil !== null) {
          conversation.compactionCircuitOpenUntil = null;
          // Mirror `trackCompactionOutcome()` — emit only on the open→closed
          // transition so clients don't receive a redundant close event when
          // the breaker was already closed.
          conversation.sendToClient({
            type: "compaction_circuit_closed",
            conversationId: conversation.conversationId,
          });
        }

        return Response.json(buildCompactionState(conversation));
      },
    },
  ];
}

/**
 * Local state-builder with the same shape as the (future) shared
 * `CompactionStateResponse`. Sibling PRs (7, 9) carry near-identical copies;
 * PR 9 extracts a consolidated version and this local copy can be deleted at
 * that cleanup step.
 */
function buildCompactionState(conversation: Conversation): {
  estimatedInputTokens: number;
  maxInputTokens: number;
  compactThresholdRatio: number;
  thresholdTokens: number;
  messageCount: number;
  contextCompactedMessageCount: number;
  contextCompactedAt: number | null;
  consecutiveCompactionFailures: number;
  compactionCircuitOpenUntil: number | null;
  isCircuitOpen: boolean;
  isCompactionEnabled: boolean;
} {
  const config = getConfig();
  const contextWindow = config.llm.default.contextWindow;
  const messages = conversation.getMessages();
  const estimatedInputTokens = estimatePromptTokens(messages);
  const maxInputTokens = contextWindow.maxInputTokens;
  const compactThresholdRatio = contextWindow.compactThreshold;
  const thresholdTokens = Math.floor(maxInputTokens * compactThresholdRatio);
  const isCircuitOpen =
    conversation.compactionCircuitOpenUntil !== null &&
    Date.now() < conversation.compactionCircuitOpenUntil;

  return {
    estimatedInputTokens,
    maxInputTokens,
    compactThresholdRatio,
    thresholdTokens,
    messageCount: messages.length,
    contextCompactedMessageCount: conversation.contextCompactedMessageCount,
    contextCompactedAt: conversation.contextCompactedAt,
    consecutiveCompactionFailures: conversation.consecutiveCompactionFailures,
    compactionCircuitOpenUntil: conversation.compactionCircuitOpenUntil,
    isCircuitOpen,
    isCompactionEnabled: contextWindow.enabled,
  };
}
