/**
 * Route definitions for the per-conversation **compaction** view.
 *
 *   GET /v1/conversations/:id/compaction?callId=…
 *
 * Reachable via the platform's `RuntimeProxyWildcardView` at
 * `/v1/assistants/{assistantId}/conversations/{conversationId}/compaction/?callId=…`.
 *
 * # Scope
 *
 * Returns the compaction(s) attributed to the call identified by
 * `callId`, ordered chronologically. A compaction is attributed to the
 * next real LLM call that ran after it, so the compactions for a given
 * call are those that landed strictly between the previous real
 * (non-`compactionAgent`) call and the selected call. This is the data
 * the Inspector's "Compaction" tab shows when you select a call in the
 * rail: it answers "which compaction reshaped the context that this
 * call ran against?".
 *
 * The window is usually empty or holds a single compaction, but the
 * recovery cascade can fire several compactions before one call lands,
 * so the response carries a list rather than a single object.
 *
 * The floor is resolved by `getPreviousNonCompactionCallCreatedAt` on
 * the log source and the ceiling is the selected call's own
 * `createdAt`. Both bounds are exclusive (the stores use strict `>` /
 * `<` predicates), so a compaction whose timestamp lands strictly
 * between the two real calls is in scope without any boundary fudging.
 *
 * # Data sources
 *
 * When `compactionLogs.destination = "clickhouse"` is configured, the
 * data is served from the first-class compaction log: the agent loop's
 * start/end event pairs written by
 * `memory/compaction-log-store-clickhouse.ts`. Those rows carry the
 * before/after context-token and message counts, real durations, the
 * trigger, and the summary text — none of which exist on
 * `llm_request_logs`.
 *
 * The legacy projection over `llm_request_logs` rows with
 * `call_site = "compactionAgent"` remains as the fallback: it serves
 * calls that predate the compaction log (the table is append-only from
 * the moment the destination is configured), assistants that never opt
 * in, and reads where the ClickHouse query fails. The legacy path can
 * only recover the summarizer call's own model/usage/text — the
 * before/after counts, duration, and trigger land as `null`.
 */

import { z } from "zod";

import {
  type CompactionLogEvent,
  getCompactionLogStore,
} from "../../persistence/compaction-log-store-clickhouse.js";
import { getConversation } from "../../persistence/conversation-crud.js";
import { getLlmRequestLogSource } from "../../persistence/llm-request-log-source.js";
import type { CompactionAgentLogRow } from "../../persistence/llm-request-log-store.js";
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
 * Wire shape for a single compaction attributed to an LLM call.
 *
 * `responseBody` (below) is the source-of-truth for the generated
 * OpenAPI client type the frontend imports
 * (`ConversationsByIdCompactionGetResponse` in
 * `clients/web/src/generated/daemon/types.gen`); regenerate the client with
 * `bun run openapi-ts` after changing the schema.
 *
 * `null` means the value isn't known for the underlying row — either the
 * legacy projection can't recover it, or the attempt never wrote its end
 * row. The frontend renders missing values as a placeholder.
 */
export interface CompactionTrailEvent {
  id: string;
  /** Epoch-ms timestamp the compaction started. */
  createdAt: number;
  /** What triggered the compaction (e.g. `budget`, `overflow`). */
  trigger: string | null;
  /** True when the attempt actually reduced the context. */
  compacted: boolean | null;
  /** True when the summarizer provider call threw. */
  summaryFailed: boolean | null;
  /**
   * Why a no-op attempt did nothing (e.g. below the auto threshold,
   * compaction disabled). Set only when `compacted` is false.
   */
  skipReason: string | null;
  /** Estimated context input tokens before the compaction ran. */
  contextTokensBefore: number | null;
  /** Estimated context input tokens after the compaction ran. */
  contextTokensAfter: number | null;
  /** Message count in the context before the compaction ran. */
  messagesBefore: number | null;
  /** Message count in the context after the compaction ran. */
  messagesAfter: number | null;
  /** How many messages were folded into the summary. */
  compactedMessages: number | null;
  /** How many recent messages were preserved verbatim past the summary. */
  preservedTailMessages: number | null;
  /**
   * Per-attempt wall-clock latency, in milliseconds. Populated from the
   * compaction log when configured; `null` on the legacy
   * `llm_request_logs` path, which has no duration column.
   */
  durationMs: number | null;
  /** Model that produced the summary. */
  summaryModel: string | null;
  /** Input tokens the summarizer call itself consumed. */
  summaryInputTokens: number | null;
  /** Output tokens the summarizer call itself produced. */
  summaryOutputTokens: number | null;
  /** The summary text that replaced the compacted span. */
  summaryText: string | null;
}

export interface CompactionTrailResponse {
  conversationId: string;
  events: CompactionTrailEvent[];
}

const compactionTrailEventSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  trigger: z.string().nullable(),
  compacted: z.boolean().nullable(),
  summaryFailed: z.boolean().nullable(),
  skipReason: z.string().nullable(),
  contextTokensBefore: z.number().nullable(),
  contextTokensAfter: z.number().nullable(),
  messagesBefore: z.number().nullable(),
  messagesAfter: z.number().nullable(),
  compactedMessages: z.number().nullable(),
  preservedTailMessages: z.number().nullable(),
  durationMs: z.number().nullable(),
  summaryModel: z.string().nullable(),
  summaryInputTokens: z.number().nullable(),
  summaryOutputTokens: z.number().nullable(),
  summaryText: z.string().nullable(),
});

const compactionTrailResponseSchema = z.object({
  conversationId: z.string(),
  events: z.array(compactionTrailEventSchema),
});

// ---------------------------------------------------------------------------
// Projection — CompactionAgentLogRow → CompactionTrailEvent
// ---------------------------------------------------------------------------

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Project a compaction-agent `llm_request_logs` row into the compaction
 * wire shape. This degraded fallback can only recover what the
 * summarizer call itself recorded: `normalizeLlmContextPayloads` pulls
 * the summary model, the summarizer's own token usage, and the summary
 * text from the response payload.
 *
 * The before/after context-token and message counts, the duration, and
 * the trigger never existed on `llm_request_logs`, so they land as
 * `null`. The request payload — an entire near-limit context window per
 * compaction — is never loaded; its message count is computed in SQL and
 * arrives on the row as `requestMessageCount` (the messages fed to the
 * summarizer, i.e. the messages that were compacted).
 *
 * Exported only for unit tests; the route handler is the sole production
 * caller.
 */
export function projectLogRowToCompactionTrailEvent(
  log: CompactionAgentLogRow,
): CompactionTrailEvent {
  const normalized = normalizeLlmContextPayloads({
    requestPayload: undefined,
    responsePayload: tryParseJson(log.responsePayload),
    createdAt: log.createdAt,
  });
  const summary: LlmContextSummary | undefined = normalized.summary;
  return {
    id: log.id,
    createdAt: log.createdAt,
    trigger: null,
    compacted: null,
    summaryFailed: null,
    skipReason: null,
    contextTokensBefore: null,
    contextTokensAfter: null,
    messagesBefore: null,
    messagesAfter: null,
    compactedMessages: log.requestMessageCount,
    preservedTailMessages: null,
    durationMs: null,
    summaryModel: summary?.model ?? null,
    summaryInputTokens: summary?.inputTokens ?? null,
    summaryOutputTokens: summary?.outputTokens ?? null,
    summaryText: summary?.responsePreview ?? null,
  };
}

/**
 * Project a paired compaction-log event into the wire shape. The headline
 * before/after figures are the context reduction the compaction achieved
 * (`contextTokensBefore`/`After`, `messagesBefore`/`After`); the
 * summarizer's own usage (`summaryInputTokens`/`OutputTokens`) is the
 * separate cost of running the compaction itself.
 *
 * `trigger` stores `""` for unknown on the row; map it back to `null` so
 * the wire shape's "not known" sentinel stays consistent.
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
    trigger: event.trigger === "" ? null : event.trigger,
    compacted: event.compacted,
    summaryFailed: event.summaryFailed,
    skipReason: event.reason,
    contextTokensBefore: event.previousEstimatedInputTokens,
    contextTokensAfter: event.estimatedInputTokens,
    messagesBefore: event.preMessageCount,
    messagesAfter: event.resultMessageCount,
    compactedMessages: event.compactedMessages,
    preservedTailMessages: event.preservedTailMessages,
    durationMs: event.durationMs,
    summaryModel: event.summaryModel,
    summaryInputTokens: event.summaryInputTokens,
    summaryOutputTokens: event.summaryOutputTokens,
    summaryText: event.summaryText,
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
  // Metadata-only lookup — the handler needs the call's conversation
  // scope and `createdAt` anchor, never its payloads (a single request
  // payload can be a full context window).
  const selectedCall = await source.getRequestLogMetaById(callId);
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

  // A compaction is attributed to the next real LLM call that ran after
  // it, so the compactions for the selected call are those that landed
  // strictly between the previous real (non-`compactionAgent`) call and
  // the selected call. The floor is the previous real call's `createdAt`
  // (null when the selected call is the first real call in the
  // conversation, leaving an open floor); the ceiling is the selected
  // call's own `createdAt`. Both stores use strict `>` / `<` predicates,
  // so no boundary fudging is needed.
  const afterCreatedAt = await source.getPreviousNonCompactionCallCreatedAt(
    conversationId,
    selectedCall.createdAt,
  );
  const beforeCreatedAt = selectedCall.createdAt;
  // Prefer the first-class compaction log when the assistant has opted
  // in. Zero rows means the call predates the log (it is append-only from
  // the moment the destination is configured), so fall through to the
  // legacy projection rather than returning an empty result; same for a
  // failed ClickHouse read. Writes are best-effort and the start/end rows
  // land independently, so an event without its end row (no `finishedAt`)
  // means the end write failed or is lagging — in that case the legacy
  // projection may still have the summarizer call details, so fall back
  // rather than serve null counts/duration.
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
    summary: "Get the compaction(s) attributed to an LLM call",
    description:
      'Return the chronological list of compactions attributed to the call identified by `callId` — those that ran strictly between the previous real (non-`compactionAgent`) LLM call and the selected call. Served from the first-class compaction log when `compactionLogs.destination = "clickhouse"` is configured, falling back to the legacy projection over `llm_request_logs` rows where `call_site = "compactionAgent"`. Usually empty or a single compaction; the recovery cascade can fire several before one call lands. Drives the Inspector\'s Compaction tab.',
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
          "ID of the selected LLM call from the rail. Defines the chronological cutoff for the attributed compactions.",
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
