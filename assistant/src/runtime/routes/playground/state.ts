/**
 * GET /v1/conversations/:id/playground/compaction-state
 *
 * Read-only view of compaction-relevant state for a conversation. Returns the
 * token estimate, the configured maxInputTokens / compactThreshold, the
 * derived threshold token count, current message count, compaction-progress
 * counters, and circuit-breaker status.
 *
 * The endpoint is gated by the `compaction-playground` feature flag via the
 * shared `assertPlaygroundEnabled` guard — when disabled the whole surface is
 * invisible in production.
 */

import { getConfig } from "../../../config/loader.js";
import { estimatePromptTokens } from "../../../context/token-estimator.js";
import type { Conversation } from "../../../daemon/conversation.js";
import type { RouteDefinition } from "../types.js";
import { throwConversationNotFound } from "./conversation-not-found.js";
import { assertPlaygroundEnabled } from "./guard.js";
import { getConversationById } from "./helpers.js";

/**
 * Build the `CompactionStateResponse` payload used by:
 *  - GET ...playground/compaction-state (this file)
 *  - POST ...playground/inject-compaction-failures (PR 7)
 *  - POST ...playground/reset-compaction-circuit (PR 8)
 *
 * Exported so follow-up cleanup PRs can replace inline copies in PR 7 / PR 8
 * with this canonical implementation.
 */
export function buildCompactionStateResponse(conversation: Conversation) {
  const messages = conversation.getMessages();
  const estimatedInputTokens = estimatePromptTokens(messages);
  const cfg = getConfig().llm.default.contextWindow;
  const maxInputTokens = cfg.maxInputTokens;
  const compactThresholdRatio = cfg.compactThreshold;
  const thresholdTokens = Math.floor(maxInputTokens * compactThresholdRatio);
  const compactionCircuitOpenUntil = conversation.compactionCircuitOpenUntil;
  return {
    estimatedInputTokens,
    maxInputTokens,
    compactThresholdRatio,
    thresholdTokens,
    messageCount: messages.length,
    contextCompactedMessageCount: conversation.contextCompactedMessageCount,
    contextCompactedAt: conversation.contextCompactedAt,
    consecutiveCompactionFailures: conversation.consecutiveCompactionFailures,
    compactionCircuitOpenUntil,
    isCircuitOpen:
      compactionCircuitOpenUntil !== null &&
      Date.now() < compactionCircuitOpenUntil,
    isCompactionEnabled: cfg.enabled,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "playgroundGetCompactionState",
    endpoint: "conversations/:id/playground/compaction-state",
    method: "GET",
    policyKey: "conversations/playground/state",
    summary: "Read current compaction state for a conversation",
    tags: ["playground"],
    pathParams: [{ name: "id", type: "uuid" }],
    handler: async ({ pathParams }) => {
      assertPlaygroundEnabled();

      const id = pathParams!.id;
      const conversation = await getConversationById(id);
      if (!conversation) {
        throwConversationNotFound(id);
      }

      return buildCompactionStateResponse(conversation);
    },
  },
];
