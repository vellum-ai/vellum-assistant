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
 * Returns every `call_site = "compactionAgent"` row that ran in the
 * **same agent turn** as the call identified by `callId`, ordered
 * chronologically. This is the data the Inspector's "Compaction" tab
 * shows when you select a call in the rail: it answers "what did the
 * compactor do across this whole turn?" — regardless of where the
 * selected call sits within the turn.
 *
 * Turn bounds are resolved by `getTurnTimeBounds` in
 * `memory/conversation-crud.ts`, which walks the `messages` table to
 * find the real user message that started the turn and the next real
 * user message (or end-of-conversation) that ends it. Tool-result user
 * messages are not turn boundaries. When the conversation has no other
 * messages around the selected call, the window collapses to the
 * call's own `createdAt` and every compaction strictly before it is
 * returned — same as the legacy behavior.
 *
 * # Why turn-scoped, not call-scoped
 *
 * A single turn can run dozens of compactions (mid-loop proactive,
 * convergence-reducer, and emergency cycles all flow through the same
 * `compactionAgent` call site). Constraining the trail to the window
 * between two adjacent calls hides most of that activity from the UI
 * — especially for the call that *yields* on a budget-exhausted error,
 * which has no compaction immediately before it but had several
 * earlier in the same turn. The turn is the right unit of analysis.
 *
 * # Data sources
 *
 * When `compactionLogs.destination = "clickhouse"` is configured, the
 * trail is served from the first-class compaction log: the agent loop's
 * start/end event pairs written by
 * `memory/compaction-log-store-clickhouse.ts`. Those rows carry real
 * durations, summary-model token totals, and trigger reasons — none of
 * which exist on `llm_request_logs`.
 *
 * The legacy projection over `llm_request_logs` rows with
 * `call_site = "compactionAgent"` remains as the fallback: it serves
 * turns that predate the compaction log (the table is append-only from
 * the moment the destination is configured), assistants that never opt
 * in, and reads where the ClickHouse query fails. On the legacy path
 * `durationMs` is always `null` — the column doesn't exist on
 * `llm_request_logs`.
 */

import { z } from "zod";

import {
  type CompactionLogEvent,
  getCompactionLogStore,
} from "../../memory/compaction-log-store-clickhouse.js";
import {
  getConversation,
  getTurnTimeBounds,
} from "../../memory/conversation-crud.js";
import { getLlmRequestLogSource } from "../../memory/llm-request-log-source.js";
import type { LogRow } from "../../memory/llm-request-log-store.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import {
  type LlmContextSummary,
  normalizeLlmContextPayloads,
} from "./llm-context-normalization.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("conversation-compaction-routes");

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
   * Per-attempt wall-clock latency, in milliseconds. Populated from the
   * compaction log when configured; always `null` on the legacy
   * `llm_request_logs` path, which has no duration column.
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

/**
 * Project a paired compaction-log event into the trail wire shape. Token
 * counts are the summarizer's own usage (what the compaction itself cost),
 * matching what the legacy path derived from the compaction agent's
 * request/response payloads.
 *
 * Exported only for unit tests; the route handler is the sole production
 * caller.
 */
export function projectCompactionLogEventToTrailEvent(
  event: CompactionLogEvent,
): CompactionTrailEvent {
  return {
    id: event.compactionId,
    createdAt: event.startedAt,
    model: event.summaryModel,
    provider: null,
    inputTokens: event.summaryInputTokens,
    outputTokens: event.summaryOutputTokens,
    durationMs: event.durationMs,
    responsePreview: event.summaryText,
    requestMessageCount: event.preMessageCount,
    stopReason: event.reason,
    estimatedCostUsd: null,
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

  // Resolve the turn window from the `messages` table — every
  // compaction between the user message that started this turn and the
  // next real user message (or end-of-conversation) is in scope.
  //
  // `getCompactionLogsBetween` uses strict `>` / `<` predicates, so we
  // shift the inclusive bounds by 1ms to capture rows landing on the
  // boundaries themselves (e.g. an emergency compaction that fires the
  // same millisecond as the assistant message terminating the turn).
  //
  // When `getTurnTimeBounds` returns `null` (the only-message case), the
  // turn-bound contract isn't established. Fall back to the selected
  // call's own `createdAt` as the ceiling and an open floor — the same
  // shape the route exposed before turn-scoping, so callers don't see
  // a regression on conversations with a single message.
  const turnBounds = getTurnTimeBounds(conversationId, selectedCall.createdAt);
  const afterCreatedAt: number | null =
    turnBounds !== null ? turnBounds.startTime - 1 : null;
  const beforeCreatedAt: number =
    turnBounds !== null ? turnBounds.endTime + 1 : selectedCall.createdAt;
  // Prefer the first-class compaction log when the assistant has opted
  // in. Zero rows means the turn predates the log (it is append-only from
  // the moment the destination is configured), so fall through to the
  // legacy projection rather than returning an empty trail; same for a
  // failed ClickHouse read. Writes are best-effort and the start/end rows
  // land independently, so an event without its end row (no `finishedAt`)
  // means the end write failed or is lagging — in that case the legacy
  // projection may still have the summarizer call details, so fall back
  // rather than serve a trail with null model/tokens/duration.
  const compactionStore = getCompactionLogStore();
  if (compactionStore) {
    try {
      const events = await compactionStore.getEventsBetween(
        conversationId,
        afterCreatedAt,
        beforeCreatedAt,
      );
      if (
        events.length > 0 &&
        events.every((event) => event.finishedAt !== null)
      ) {
        return {
          conversationId,
          events: events.map(projectCompactionLogEventToTrailEvent),
        };
      }
    } catch (err) {
      log.warn(
        { err, conversationId, callId },
        "Compaction log read failed; falling back to llm_request_logs projection",
      );
    }
  }

  const logs = await source.getCompactionLogsBetween(
    conversationId,
    afterCreatedAt,
    beforeCreatedAt,
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
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get the compaction trail leading up to an LLM call",
    description:
      'Return the chronological list of compaction events that ran in the same agent turn as the call identified by `callId`. Turn bounds are walked from the `messages` table (real user messages — tool-result user messages are not boundaries). Served from the first-class compaction log when `compactionLogs.destination = "clickhouse"` is configured, falling back to the legacy projection over `llm_request_logs` rows where `call_site = "compactionAgent"`. When the conversation has no other messages around the selected call, every compaction strictly before the call\'s `createdAt` is in scope. Drives the Inspector\'s Compaction tab.',
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
