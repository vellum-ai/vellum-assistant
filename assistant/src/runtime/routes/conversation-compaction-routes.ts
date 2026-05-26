/**
 * Route definitions for the per-conversation **compaction trail** view.
 *
 *   GET /v1/conversations/:id/compaction?callId=…
 *
 * Reachable via the platform's `RuntimeProxyWildcardView` at
 * `/v1/assistants/{assistantId}/conversations/{conversationId}/compaction/?callId=…`.
 *
 * # Scope
 *
 * Returns the set of `call_site = "compactionAgent"` rows in this
 * conversation that ran **before** the LLM call identified by `callId`,
 * ordered chronologically. This is the data the Inspector's "Compaction"
 * tab shows when you select a call in the rail: it answers "what did the
 * compactor do to my context before this call?".
 *
 * # Data model decision (in progress)
 *
 * Today the trail is projected from `llm_request_logs` rows alone — no
 * `compaction_logs` table exists yet (#32055 remains a draft). This MVP
 * route exists precisely to test whether the projected shape is enough.
 * If real-world use surfaces UX needs that aren't in `llm_request_logs`
 * (most likely: per-event duration, structured before/after counts,
 * trigger reason), that becomes the concrete justification for the new
 * table. Until then, missing fields surface as `null` and the Compaction
 * tab renders `"Unavailable"` for them.
 *
 * In particular, `durationMs` is always `null` for now — the column
 * doesn't exist on `llm_request_logs` and we deliberately ship the route
 * without it to surface the gap in the UI.
 */

import { z } from "zod";

import { getConversation } from "../../memory/conversation-crud.js";
import { getLlmRequestLogSource } from "../../memory/llm-request-log-source.js";
import type { LogRow } from "../../memory/llm-request-log-store.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import {
  type LlmContextSummary,
  normalizeLlmContextPayloads,
} from "./llm-context-normalization.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/**
 * Wire shape for a single compaction event. Mirrors the React Query
 * response type at
 * `apps/web/src/domains/chat/inspector/compaction-trail-types.ts`.
 * Keep the two in sync — until the OpenAPI client generator picks up
 * this route, the frontend type is hand-maintained.
 */
export interface CompactionTrailEvent {
  id: string;
  createdAt: number;
  model: string | null;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * Per-call wall-clock latency, in milliseconds. **Always `null` for
   * now** — `llm_request_logs` doesn't carry a duration column. Surfacing
   * the gap in the UI is intentional: if engineers consistently miss
   * having latency here, that's a concrete signal to extend the row
   * (either as a column on `llm_request_logs` or on a dedicated
   * `compaction_logs` table per the open data-model decision).
   */
  durationMs: number | null;
  responsePreview: string | null;
  requestMessageCount: number | null;
  stopReason: string | null;
  estimatedCostUsd: number | null;
}

export interface CompactionTrailResponse {
  conversationId: string;
  events: CompactionTrailEvent[];
}

const compactionTrailEventSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  durationMs: z.number().nullable(),
  responsePreview: z.string().nullable(),
  requestMessageCount: z.number().nullable(),
  stopReason: z.string().nullable(),
  estimatedCostUsd: z.number().nullable(),
});

const compactionTrailResponseSchema = z.object({
  conversationId: z.string(),
  events: z.array(compactionTrailEventSchema),
});

// ---------------------------------------------------------------------------
// Projection — LogRow → CompactionTrailEvent
// ---------------------------------------------------------------------------

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Project a raw `llm_request_logs` row into the compaction-trail wire
 * shape. Reuses `normalizeLlmContextPayloads` so model/provider/token
 * extraction stays consistent with what the rest of the inspector shows.
 *
 * Fields the normalizer can't derive (today: `durationMs`) land as
 * `null` — see the `CompactionTrailEvent.durationMs` doc comment for the
 * rationale.
 *
 * Exported only for unit tests; the route handler is the sole production
 * caller.
 */
export function projectLogRowToCompactionTrailEvent(
  log: LogRow,
): CompactionTrailEvent {
  const normalized = normalizeLlmContextPayloads({
    requestPayload: tryParseJson(log.requestPayload),
    responsePayload: tryParseJson(log.responsePayload),
    createdAt: log.createdAt,
  });
  const summary: LlmContextSummary | undefined = normalized.summary;
  return {
    id: log.id,
    createdAt: log.createdAt,
    model: summary?.model ?? null,
    // Prefer the normalized provider (derived from payload shape) over
    // the stored column. Stored `provider` is the originating call's
    // own identifier and matches the normalizer in all cases we ship
    // today, but the normalizer is the source-of-truth used by sibling
    // inspector tabs — keep that alignment.
    provider: summary?.provider ?? log.provider ?? null,
    inputTokens: summary?.inputTokens ?? null,
    outputTokens: summary?.outputTokens ?? null,
    durationMs: null,
    responsePreview: summary?.responsePreview ?? null,
    requestMessageCount: summary?.requestMessageCount ?? null,
    stopReason: summary?.stopReason ?? null,
    estimatedCostUsd: summary?.estimatedCostUsd ?? null,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleGetCompactionTrail({
  pathParams = {},
  queryParams = {},
}: RouteHandlerArgs): Promise<CompactionTrailResponse> {
  const conversationId = pathParams.id;
  const callId = queryParams.callId;

  if (!conversationId) {
    throw new BadRequestError("conversation id path parameter is required");
  }
  if (!callId) {
    throw new BadRequestError("callId query parameter is required");
  }

  // Verify the conversation exists before we touch the log source —
  // a missing conversation should 404, not return an empty trail with
  // no signal that the caller had the wrong id.
  const conversation = getConversation(conversationId);
  if (!conversation) {
    throw new NotFoundError(`Conversation ${conversationId} not found`);
  }

  const source = await getLlmRequestLogSource();
  const selectedCall = await source.getRequestLogById(callId);
  if (!selectedCall) {
    throw new NotFoundError(`LLM call ${callId} not found`);
  }
  if (selectedCall.conversationId !== conversationId) {
    // Treat a cross-conversation callId as a bad request rather than
    // silently filtering against the wrong conversation. The frontend
    // always pairs (conversationId, callId) from the same rail, so a
    // mismatch is a real client bug — surface it.
    throw new BadRequestError(
      `LLM call ${callId} does not belong to conversation ${conversationId}`,
    );
  }

  const logs = await source.getCompactionLogsBeforeCall(
    conversationId,
    selectedCall.createdAt,
  );

  return {
    conversationId,
    events: logs.map(projectLogRowToCompactionTrailEvent),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "conversations_compaction_trail_get",
    endpoint: "conversations/:id/compaction",
    method: "GET",
    policyKey: "conversations/compaction",
    summary: "Get the compaction trail leading up to an LLM call",
    description:
      "Return the chronological list of compaction events that ran in this conversation before the LLM call identified by `callId`. Projected from `llm_request_logs` rows where `call_site = \"compactionAgent\"` and `created_at < callRow.createdAt`. Drives the Inspector's Compaction tab.",
    tags: ["conversations"],
    pathParams: [
      {
        name: "id",
        description: "Internal conversation identifier.",
      },
    ],
    queryParams: [
      {
        name: "callId",
        required: true,
        schema: { type: "string" },
        description:
          "ID of the selected LLM call from the rail. Defines the chronological cutoff for the trail.",
      },
    ],
    responseBody: compactionTrailResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "Returned when the callId is missing or refers to a call in a different conversation.",
      },
      "404": {
        description:
          "Returned when the conversation or the referenced LLM call does not exist.",
      },
    },
    handler: handleGetCompactionTrail,
  },
];
