/**
 * POST /v1/conversations/:id/playground/inject-compaction-failures
 * directly mutates the compaction circuit-breaker state on a conversation.
 *
 * This is a dev-only playground endpoint gated by the
 * `compaction-playground` feature flag. It lets integration tests and the
 * macOS playground UI drive the circuit breaker into interesting states
 * without having to wait for real consecutive summary-LLM failures.
 *
 * When `circuitOpenForMs` is set to a positive number, the endpoint emits a
 * `compaction_circuit_open` event with reason `3_consecutive_failures`
 * (matching the event shape produced by `trackCompactionOutcome` in
 * `conversation-agent-loop.ts`). Passing `circuitOpenForMs: 0` clears the
 * open-until timestamp and emits `compaction_circuit_closed`, mirroring the
 * transition event the daemon emits on the open → closed edge.
 */

import { z } from "zod";

import { getConfig } from "../../../config/loader.js";
import { estimatePromptTokens } from "../../../context/token-estimator.js";
import type { Conversation } from "../../../daemon/conversation.js";
import { httpError } from "../../http-errors.js";
import type { RouteDefinition } from "../../http-router.js";
import { assertPlaygroundEnabled } from "./guard.js";
import type { PlaygroundRouteDeps } from "./index.js";

const InjectBodySchema = z.object({
  consecutiveFailures: z.number().int().min(0).max(10).optional(),
  circuitOpenForMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000)
    .optional(),
});

export function injectFailuresRouteDefinitions(
  deps: PlaygroundRouteDeps,
): RouteDefinition[] {
  return [
    {
      endpoint: "conversations/:id/playground/inject-compaction-failures",
      method: "POST",
      policyKey: "conversations/playground/inject-failures",
      summary:
        "Directly mutate compaction circuit-breaker state (dev-only playground)",
      tags: ["playground"],
      requestBody: InjectBodySchema,
      handler: async ({ req, params }) => {
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

        let rawBody: unknown = {};
        try {
          const contentLength = req.headers.get("content-length");
          if (contentLength !== "0" && req.body !== null) {
            rawBody = await req.json();
          }
        } catch {
          return httpError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const parsed = InjectBodySchema.safeParse(rawBody ?? {});
        if (!parsed.success) {
          return httpError("BAD_REQUEST", parsed.error.message, 400);
        }
        const { consecutiveFailures, circuitOpenForMs } = parsed.data;

        if (consecutiveFailures !== undefined) {
          conversation.consecutiveCompactionFailures = consecutiveFailures;
        }

        if (circuitOpenForMs !== undefined) {
          if (circuitOpenForMs === 0) {
            conversation.compactionCircuitOpenUntil = null;
            // Mirror the `compaction_circuit_closed` transition event the
            // daemon emits when the breaker auto-closes after a successful
            // compaction, so the Swift banner dismisses immediately.
            conversation.sendToClient({
              type: "compaction_circuit_closed",
              conversationId: conversation.conversationId,
            });
          } else {
            const openUntil = Date.now() + circuitOpenForMs;
            conversation.compactionCircuitOpenUntil = openUntil;
            conversation.sendToClient({
              type: "compaction_circuit_open",
              conversationId: conversation.conversationId,
              reason: "3_consecutive_failures",
              openUntil,
            });
          }
        }

        return Response.json(buildCompactionState(conversation));
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Local state-builder — shared shape across PR 7/8/9.
//
// PR 9 (the state endpoint) will extract a canonical shared implementation of
// this helper. For now each parallel PR maintains an identical copy so the
// three file-level diffs stay independent.
// ---------------------------------------------------------------------------

export interface CompactionStateResponse {
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
}

function buildCompactionState(
  conversation: Conversation,
): CompactionStateResponse {
  const ctxConfig = getConfig().llm.default.contextWindow;
  const maxInputTokens = ctxConfig.maxInputTokens;
  const compactThresholdRatio = ctxConfig.compactThreshold;
  const isCompactionEnabled = ctxConfig.enabled;
  const thresholdTokens = Math.floor(maxInputTokens * compactThresholdRatio);

  const messages = conversation.getMessages();
  const estimatedInputTokens = estimatePromptTokens(messages);
  const circuitOpenUntil = conversation.compactionCircuitOpenUntil;
  const isCircuitOpen =
    circuitOpenUntil !== null && Date.now() < circuitOpenUntil;

  return {
    estimatedInputTokens,
    maxInputTokens,
    compactThresholdRatio,
    thresholdTokens,
    messageCount: messages.length,
    contextCompactedMessageCount: conversation.contextCompactedMessageCount,
    contextCompactedAt: conversation.contextCompactedAt,
    consecutiveCompactionFailures: conversation.consecutiveCompactionFailures,
    compactionCircuitOpenUntil: circuitOpenUntil,
    isCircuitOpen,
    isCompactionEnabled,
  };
}
