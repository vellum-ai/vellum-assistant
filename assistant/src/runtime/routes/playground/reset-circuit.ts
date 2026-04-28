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
import type { RouteDefinition } from "../types.js";
import { throwConversationNotFound } from "./conversation-not-found.js";
import { assertPlaygroundEnabled } from "./guard.js";
import { getConversationById } from "./helpers.js";

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "playgroundResetCompactionCircuit",
    endpoint: "conversations/:id/playground/reset-compaction-circuit",
    method: "POST",
    policyKey: "conversations/playground/reset-circuit",
    summary: "Clear compaction circuit-breaker state (dev-only playground)",
    tags: ["playground"],
    pathParams: [{ name: "id", type: "uuid" }],
    handler: async ({ pathParams }) => {
      assertPlaygroundEnabled();

      const id = pathParams!.id;
      const conversation = await getConversationById(id);
      if (!conversation) {
        throwConversationNotFound(id);
      }

      conversation.consecutiveCompactionFailures = 0;
      if (conversation.compactionCircuitOpenUntil !== null) {
        conversation.compactionCircuitOpenUntil = null;
        conversation.sendToClient({
          type: "compaction_circuit_closed",
          conversationId: conversation.conversationId,
        });
      }

      return buildCompactionState(conversation);
    },
  },
];

function buildCompactionState(conversation: Conversation) {
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
