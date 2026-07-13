/**
 * Per-event-type telemetry sources for the usage telemetry reporter.
 *
 * Each {@link TelemetryEventSource} owns one event type end-to-end: querying
 * unreported rows after a compound `(createdAt, id)` cursor, mapping them to
 * wire events, and deciding which rows are reportable this cycle (the turn
 * source defers in-flight turns). The reporter is a generic engine over a
 * list of sources, so which process flushes which event types is a matter of
 * which sources its reporter instance is constructed with.
 */

import { queryUnreportedUsageEvents } from "../persistence/llm-usage-store.js";
import {
  getCachedShareDiagnostics,
  getCachedShareDiagnosticsVersion,
} from "../platform/consent-cache.js";
import type { UsageAttributionProfileSource } from "../usage/types.js";
import { getLogger } from "../util/logger.js";
import { APP_VERSION } from "../version.js";
import {
  deleteTelemetryOutboxEvents,
  discardPendingTelemetryOutboxEvents,
  queryTelemetryOutboxBatch,
} from "./telemetry-events-outbox.js";
import { queryUnreportedToolExecutedEvents } from "./tool-executed-events-store.js";
import { isDiagnosticsConsentVersionEligible } from "./trace-collection-policy.js";
import { queryUnreportedTurnEvents } from "./turn-events-store.js";
import { assembleBoundedTurnTrace, isTurnSettled } from "./turn-trace-store.js";
import type {
  OutboxTelemetryEventName,
  TelemetryEvent,
  TurnTelemetryClientInfo,
} from "./types.js";

const log = getLogger("usage-telemetry");

/** Compound `(createdAt, id)` position of a reported row. */
export interface TelemetryCursor {
  createdAt: number;
  id: string;
}

/** One flush cycle's worth of reportable events from a single source. */
export interface TelemetryEventSourceBatch {
  /** Wire events for the rows reportable this cycle, in cursor order. */
  events: TelemetryEvent[];
  /**
   * Row ids backing `events`, set by ack-mode sources so the reporter can
   * acknowledge (delete) exactly the shipped rows. These are ROW ids, not
   * wire `daemon_event_id`s — the onboarding source overrides
   * `daemon_event_id` for activation rows, so the two can differ.
   */
  rowIds?: string[];
  /** Cursor of the last reportable row; null when nothing is reportable. */
  lastCursor: TelemetryCursor | null;
  /**
   * True when this source may have more rows immediately behind the batch
   * (drives the reporter's recurse-after-success). Sources that defer rows
   * (the turn completeness barrier) key this off the REPORTED count so a
   * truncated batch waits for a later flush instead of re-querying and
   * re-deferring in a tight recursion.
   */
  fullBatch: boolean;
}

/** One event type's query + wire mapping, keyed by its watermark namespace. */
export interface TelemetryEventSource {
  /**
   * Stable source id — the watermark key namespace. The reporter persists
   * this source's cursor under `telemetry:<id>:last_reported_{at,id}` in the
   * telemetry DB's `flush_checkpoints` table, so ids must never change once
   * shipped.
   */
  id: string;
  /** Query rows after the compound cursor and map them to wire events. */
  collect(
    afterCreatedAt: number,
    afterId: string | undefined,
    limit: number,
  ): TelemetryEventSourceBatch;
  /**
   * Delete-on-flush mode. Both operations are required together: `acknowledge`
   * deletes the rows behind {@link TelemetryEventSourceBatch.rowIds} after a
   * 2xx from the ingest endpoint, and `discardPending` drops all pending rows
   * on an opted-out flush (watermark writes are meaningless for ack-mode
   * sources, so they never touch `flush_checkpoints`).
   */
  ack?: {
    acknowledge(rowIds: string[]): void;
    discardPending(): void;
  };
}

/** The `flush_checkpoints` keys holding a source's compound cursor. */
export function watermarkKeysForSource(sourceId: string): {
  at: string;
  id: string;
} {
  return {
    at: `telemetry:${sourceId}:last_reported_at`,
    id: `telemetry:${sourceId}:last_reported_id`,
  };
}

/**
 * Build a source for the common case: every queried row is reportable, the
 * cursor advances to the last queried row, and a full query batch signals
 * more rows behind it.
 */
function simpleSource<Row extends { id: string; createdAt: number }>(
  id: string,
  query: (
    afterCreatedAt: number,
    afterId: string | undefined,
    limit: number,
  ) => Row[],
  toEvent: (row: Row) => TelemetryEvent,
): TelemetryEventSource {
  return {
    id,
    collect(afterCreatedAt, afterId, limit) {
      const rows = query(afterCreatedAt, afterId, limit);
      const last = rows.length > 0 ? rows[rows.length - 1] : null;
      return {
        events: rows.map(toEvent),
        lastCursor: last ? { createdAt: last.createdAt, id: last.id } : null,
        fullBatch: rows.length === limit,
      };
    },
  };
}

/**
 * Build an ack-mode source over the generic `telemetry_events` outbox for one
 * event name. `collect` ignores the cursor args — acknowledged rows are
 * deleted, so the head of the queue is always the next batch — and parses
 * each stored payload into its wire event. A row whose payload does not parse
 * to an object is purged immediately with a warn: an early empty-batch return
 * in the reporter would otherwise strand it at the head of the queue forever.
 */
export function outboxSource(
  name: OutboxTelemetryEventName,
): TelemetryEventSource {
  return {
    id: name,
    collect(_afterCreatedAt, _afterId, limit) {
      const rows = queryTelemetryOutboxBatch(name, limit);
      const events: TelemetryEvent[] = [];
      const rowIds: string[] = [];
      const corruptIds: string[] = [];
      for (const row of rows) {
        let event: TelemetryEvent | null = null;
        try {
          const parsed = JSON.parse(row.payload) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            event = parsed as TelemetryEvent;
          }
        } catch {
          // Fall through to the purge below.
        }
        if (event) {
          events.push(event);
          rowIds.push(row.id);
        } else {
          corruptIds.push(row.id);
          log.warn(
            { name, rowId: row.id, payloadLength: row.payload.length },
            "Telemetry outbox: unparseable payload — purging row",
          );
        }
      }
      if (corruptIds.length > 0) {
        deleteTelemetryOutboxEvents(corruptIds);
      }
      return {
        events,
        rowIds,
        lastCursor: null,
        fullBatch: rows.length === limit,
      };
    },
    ack: {
      acknowledge: (rowIds) => deleteTelemetryOutboxEvents(rowIds),
      discardPending: () => discardPendingTelemetryOutboxEvents(name),
    },
  };
}

/**
 * Build an ack-mode source like {@link outboxSource}, but additionally
 * re-checks `share_diagnostics` eligibility (at an eligible accepted
 * version) on every collect, not just at record time. A writer's record-
 * time gate only covers the moment the row is recorded — if the owner
 * revokes diagnostics consent after that but before the next flush, a
 * still-pending row must not ship anyway (unlike `turnSource`'s trace,
 * which is assembled fresh at flush time and so re-evaluates consent for
 * free, a pre-built outbox payload has no such natural re-check point).
 * Ineligible pending rows are purged outright rather than held for a later
 * re-check, mirroring the corrupt-payload purge above — consent revocation
 * calls for dropping the backlog, not retrying it.
 */
function diagnosticsGatedOutboxSource(
  name: OutboxTelemetryEventName,
): TelemetryEventSource {
  const base = outboxSource(name);
  return {
    id: base.id,
    collect(afterCreatedAt, afterId, limit) {
      if (
        !getCachedShareDiagnostics() ||
        !isDiagnosticsConsentVersionEligible(getCachedShareDiagnosticsVersion())
      ) {
        const rows = queryTelemetryOutboxBatch(name, limit);
        if (rows.length > 0) {
          deleteTelemetryOutboxEvents(rows.map((row) => row.id));
        }
        return {
          events: [],
          rowIds: [],
          lastCursor: null,
          fullBatch: rows.length === limit,
        };
      }
      return base.collect(afterCreatedAt, afterId, limit);
    },
    ack: base.ack,
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const usageSource = simpleSource(
  "usage",
  (afterCreatedAt, afterId, limit) =>
    queryUnreportedUsageEvents(afterCreatedAt, afterId, limit),
  (e): TelemetryEvent => ({
    type: "llm_usage",
    daemon_event_id: e.id,
    // Conversation-level metadata for analytics joins. All three
    // are nullable on the wire: `conversation_id` is null for
    // LLM calls not tied to a conversation (memory consolidation,
    // background work), and the other two cascade from that.
    conversation_id: e.conversationId,
    conversation_type: e.conversationType,
    turn_index: e.turnIndex,
    provider: e.provider,
    model: e.model,
    input_tokens: e.inputTokens,
    output_tokens: e.outputTokens,
    cache_creation_input_tokens: e.cacheCreationInputTokens ?? null,
    cache_read_input_tokens: e.cacheReadInputTokens ?? null,
    llm_call_count: e.llmCallCount,
    raw_usage: e.rawUsage,
    actor: e.actor,
    llm_call_site: e.callSite,
    inference_profile: e.inferenceProfile,
    inference_profile_source: e.inferenceProfileSource,
    cost: e.estimatedCostUsd ?? null,
    recorded_at: e.createdAt,
    // Record-time version when present; otherwise the running
    // binary's `APP_VERSION` (a legacy row from before
    // migration 267 ran). We deliberately don't emit explicit
    // `null` — under the platform contract a present-but-null
    // per-event value would override the envelope, and we'd
    // rather have a concrete version than no version.
    assistant_version: e.assistantVersion ?? APP_VERSION,
  }),
);

/**
 * Turn source. Unlike the simple sources it enforces the turn completeness
 * barrier and attaches consented traces, both of which need the daemon's
 * live in-memory conversation state (`isProcessing()`, cached system prompt,
 * registered tool definitions) — so this source must run in the daemon
 * process.
 */
const turnSource: TelemetryEventSource = {
  id: "turns",
  collect(afterCreatedAt, afterId, limit) {
    const turnEvents = queryUnreportedTurnEvents(
      afterCreatedAt,
      afterId,
      limit,
    );

    // Turn completeness barrier (every turn event).
    //
    // A turn event must only be sent once that turn is COMPLETE, for two
    // reasons sharing the same failure mode (the watermark advances on ship,
    // so anything captured early is frozen forever):
    //   - the consented `trace` would capture a partial mid-reply
    //     transcript, and
    //   - the `outcome` stamp (`messages.metadata.turnOutcome`, written by
    //     the agent loop / drainBatch while the conversation is still
    //     processing) would be missed, permanently mislabeling a
    //     failed/cancelled/batched turn as normally-replied.
    // So we report only the leading run of complete turns and STOP at the
    // first incomplete (in-flight) one: the turn watermark is a single
    // monotonic `(createdAt, id)` cursor, so a later complete turn cannot be
    // reported past an earlier deferred one without skipping it. The
    // deferred turn (and everything after it) is picked up on a later flush
    // once its response settles.
    //
    // Trace eligibility is composed daemon-side to mirror the platform's
    // authoritative owner-based ingest gate, so traces for ineligible owners
    // never leave the device. Two parts, fail-closed (both must be true):
    //   1. the owner's cached `share_diagnostics` consent, and
    //   2. the owner's cached `share_diagnostics_accepted_version` being at or
    //      past the disclosing version — the platform applies the identical
    //      check, so an old consent never yields a trace here or there.
    const traceEligible =
      getCachedShareDiagnostics() &&
      isDiagnosticsConsentVersionEligible(getCachedShareDiagnosticsVersion());
    let reportableTurnEvents = turnEvents;
    if (turnEvents.length > 0) {
      let barrier = turnEvents.length;
      for (let i = 0; i < turnEvents.length; i++) {
        const t = turnEvents[i];
        if (
          !isTurnSettled({
            conversationId: t.conversationId,
            userMessageId: t.id,
            userMessageCreatedAt: t.createdAt,
          })
        ) {
          barrier = i;
          break;
        }
      }
      if (barrier < turnEvents.length) {
        reportableTurnEvents = turnEvents.slice(0, barrier);
        log.debug(
          {
            deferredTurnId: turnEvents[barrier].id,
            deferredConversationId: turnEvents[barrier].conversationId,
            reportedTurns: barrier,
            deferredTurns: turnEvents.length - barrier,
          },
          "Deferring in-progress turn(s) from telemetry until complete",
        );
      }
    }

    const events = reportableTurnEvents.map((e): TelemetryEvent => {
      // Per-turn trace collection gate. `traceEligible` (computed above)
      // requires the owner's cached `share_diagnostics` consent AND an
      // eligible accepted consent version. Fail-closed: when either is off
      // the trace is omitted and the trace-free turn row flushes as before. The
      // `share_analytics` gate in the reporter already passed, so this is an
      // additional, independent gate specific to trace PII. Every turn
      // reaching here is settled (the completeness barrier dropped any
      // in-flight turns), so the trace is never a partial mid-turn snapshot.
      const trace = traceEligible
        ? assembleBoundedTurnTrace({
            conversationId: e.conversationId,
            userMessageId: e.id,
            userMessageCreatedAt: e.createdAt,
          })
        : null;
      // `messages.metadata.client` is a nested JSON object extracted
      // via `json_extract`; sqlite returns it as a text representation.
      // Parse defensively — a corrupted blob in the JSON column should
      // not block the whole batch flush.
      let client: TurnTelemetryClientInfo | null = null;
      if (e.clientMetadata) {
        try {
          const parsed = JSON.parse(e.clientMetadata) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            client = parsed as TurnTelemetryClientInfo;
          }
        } catch {
          // Malformed client JSON — emit null rather than fail the
          // batch. Logged once below for visibility.
          log.warn(
            { turnId: e.id, conversationId: e.conversationId },
            "Telemetry turn: failed to parse messages.metadata.client; emitting null",
          );
        }
      }
      // Narrow the raw metadata projection to the wire union — only
      // `stampTurnOutcome` writes the key, but the JSON column is
      // uncontrolled, so an unexpected value is dropped rather than
      // shipped.
      const outcome =
        e.outcome === "batched" ||
        e.outcome === "failed" ||
        e.outcome === "cancelled"
          ? e.outcome
          : null;
      return {
        type: "turn",
        daemon_event_id: e.id,
        recorded_at: e.createdAt,
        conversation_id: e.conversationId,
        conversation_type: e.conversationType,
        turn_index: e.turnIndex,
        interface_id: e.interfaceId,
        channel_id: e.channelId,
        client,
        // Outcome stamps are omit-when-absent: a normally-replied turn's
        // wire shape is byte-identical to a pre-outcome turn event.
        ...(outcome ? { outcome } : {}),
        ...(outcome === "batched" && e.batchedInto
          ? { batched_into: e.batchedInto }
          : {}),
        ...(outcome === "failed" && e.failureCode
          ? { failure_code: e.failureCode }
          : {}),
        // Only attach `trace` when consent is on AND a bounded trace was
        // assembled. Omitting the key entirely when there's no trace keeps
        // the wire shape byte-identical to pre-trace turn events for the
        // common (no-consent) path.
        ...(trace ? { trace } : {}),
        // Turn events derive from `messages` + `conversations`
        // rather than a dedicated table. Adding `assistant_version`
        // to `messages` is a separate (larger) migration; until
        // then we stamp the running binary's `APP_VERSION` so the
        // wire value is concrete (matches what the envelope would
        // have provided, but per-event so it survives the platform
        // contract that treats present per-event values as winning
        // over the envelope).
        assistant_version: APP_VERSION,
      };
    });

    const last =
      reportableTurnEvents.length > 0
        ? reportableTurnEvents[reportableTurnEvents.length - 1]
        : null;
    return {
      events,
      // The cursor advances only to the last REPORTED turn. Deferred
      // (in-flight) turns sit beyond it and are re-evaluated on a later
      // flush, so the watermark never skips them.
      lastCursor: last ? { createdAt: last.createdAt, id: last.id } : null,
      // Keyed off the REPORTED count: when the completeness barrier
      // truncates the batch, the deferred turns must wait for a later flush
      // (by which point they've settled) rather than being re-queried and
      // re-deferred in a tight recursion.
      fullBatch: reportableTurnEvents.length === limit,
    };
  },
};

const toolExecutedSource = simpleSource(
  "tool_executed",
  (afterCreatedAt, afterId, limit) =>
    queryUnreportedToolExecutedEvents(afterCreatedAt, afterId, limit),
  (e): TelemetryEvent => ({
    type: "tool_executed",
    daemon_event_id: e.id,
    recorded_at: e.createdAt,
    tool_name: e.toolName,
    // The store filters out permission-denied rows, so the only
    // non-success decision that reaches here is "error".
    status: e.decision === "error" ? "errored" : "fulfilled",
    duration_ms: e.durationMs,
    arg_bytes: e.argBytes,
    result_bytes: e.resultBytes,
    conversation_id: e.conversationId,
    provider: e.provider,
    model: e.model,
    inference_profile: e.inferenceProfile,
    inference_profile_source:
      e.inferenceProfileSource as UsageAttributionProfileSource | null,
    // `tool_invocations` has no record-time version column — stamp
    // the running binary's `APP_VERSION` so the wire value is
    // concrete rather than an explicit null that would override the
    // envelope under the platform's per-event-wins contract.
    assistant_version: APP_VERSION,
  }),
);

/**
 * Watermark key namespace of the tool_executed source — referenced by the
 * absent-watermark init that runs at daemon startup.
 */
export const TOOL_EXECUTED_SOURCE_ID = toolExecutedSource.id;

/**
 * Every telemetry event source, in payload order. The order is part of the
 * observable wire behavior (events of different types appear in this order
 * within one batch), so keep it stable. This is the test/reference list;
 * production reporters run the daemon/monitor partitions below.
 */
export const ALL_TELEMETRY_EVENT_SOURCES: readonly TelemetryEventSource[] = [
  usageSource,
  turnSource,
  outboxSource("lifecycle"),
  outboxSource("onboarding"),
  outboxSource("auth_fallback"),
  toolExecutedSource,
  outboxSource("skill_loaded"),
  outboxSource("watchdog"),
  outboxSource("config_setting"),
  // Onboarding research-turn results are client-orchestrated (the web
  // client reports the settled `{claims, suggestions, plugins}` payload
  // once via POST /v1/telemetry/onboarding-research) but land in the same
  // outbox as every other event type. Diagnostics-gated at flush time (not
  // just record time) since the payload carries raw inferred claims.
  diagnosticsGatedOutboxSource("onboarding_research"),
];

/**
 * Sources flushed by the daemon's reporter. Turns only: the completeness
 * barrier (`isProcessing()`) and consented trace assembly (cached system
 * prompt, registered tool definitions) read the daemon's live in-memory
 * conversation state, so this source cannot leave the daemon process.
 */
export const DAEMON_TELEMETRY_EVENT_SOURCES: readonly TelemetryEventSource[] = [
  turnSource,
];

/**
 * Sources flushed by the resource monitor process's reporter. Everything
 * except turns: pure durable-table projections over the main and telemetry
 * databases, which the monitor reads cross-process (main DB read-only via
 * WAL; telemetry DB read-write, since the monitor owns flush state).
 * Together with {@link DAEMON_TELEMETRY_EVENT_SOURCES} this partitions
 * {@link ALL_TELEMETRY_EVENT_SOURCES} — every source is flushed by exactly
 * one process.
 */
export const MONITOR_TELEMETRY_EVENT_SOURCES: readonly TelemetryEventSource[] =
  ALL_TELEMETRY_EVENT_SOURCES.filter(
    (source) => !DAEMON_TELEMETRY_EVENT_SOURCES.includes(source),
  );
