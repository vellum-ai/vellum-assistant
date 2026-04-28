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
import { BadRequestError } from "../errors.js";
import type { RouteDefinition } from "../types.js";
import { throwConversationNotFound } from "./conversation-not-found.js";
import { assertPlaygroundEnabled } from "./guard.js";
import { getConversationById } from "./helpers.js";

const InjectBodySchema = z.object({
  consecutiveFailures: z.number().int().min(0).max(10).optional(),
  circuitOpenForMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000)
    .optional(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "playgroundInjectCompactionFailures",
    endpoint: "conversations/:id/playground/inject-compaction-failures",
    method: "POST",
    policyKey: "conversations/playground/inject-failures",
    summary:
      "Directly mutate compaction circuit-breaker state (dev-only playground)",
    tags: ["playground"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: InjectBodySchema,
    handler: async ({ pathParams, body }) => {
      assertPlaygroundEnabled();

      const id = pathParams!.id;
      const conversation = await getConversationById(id);
      if (!conversation) {
        throwConversationNotFound(id);
      }

      const parsed = InjectBodySchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.message);
      }
      const { consecutiveFailures, circuitOpenForMs } = parsed.data;

      if (consecutiveFailures !== undefined) {
        conversation.consecutiveCompactionFailures = consecutiveFailures;
      }

      if (circuitOpenForMs !== undefined) {
        if (circuitOpenForMs === 0) {
          if (conversation.compactionCircuitOpenUntil !== null) {
            conversation.compactionCircuitOpenUntil = null;
            conversation.sendToClient({
              type: "compaction_circuit_closed",
              conversationId: conversation.conversationId,
            });
          }
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

      return buildCompactionState(conversation);
    },
  },
];

// ---------------------------------------------------------------------------
// Local state-builder — identical in shape to `buildCompactionStateResponse`
// in `state.ts` and the local copy in `reset-circuit.ts`. A follow-up cleanup
// can consolidate these onto `state.ts`'s exported helper.
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
