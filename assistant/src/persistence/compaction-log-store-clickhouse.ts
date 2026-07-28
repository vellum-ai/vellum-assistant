/**
 * ClickHouse compaction log store.
 *
 * Consumes the agent loop's compaction start/end event pair
 * (`context_compacting` / `compaction_completed`, correlated by
 * `compactionId`) and writes one row per event to the ClickHouse table
 * configured under `compactionLogs` in workspace config. Disabled unless
 * `compactionLogs.destination === "clickhouse"` — there is no SQLite
 * destination.
 *
 * The table is event-sourced rather than upserted: a `start` row records
 * that an attempt began (so attempts that never complete — pipeline throw,
 * turn abort — are still visible), and an `end` row carries the
 * `ContextWindowResult` fields unnested on the event. Consumers pair rows
 * by `compaction_id`.
 *
 * The store also serves reads: the compaction-trail route pairs the rows
 * back into per-attempt events via `getEventsBetween`.
 *
 * Writes are strictly best-effort: every entry point swallows and logs
 * failures so a ClickHouse outage can never abort a turn. URL and password
 * come from the credential store (`clickhouse:url`, `clickhouse:password`),
 * matching the `llmRequestLogs` mirror convention; database/table/user come
 * from config. The table is created lazily with `CREATE TABLE IF NOT EXISTS`
 * on first write so opting in requires no out-of-band DDL.
 */
import type { AgentEvent } from "../agent/loop.js";
import { getConfig } from "../config/loader.js";
import type { CompactionLogsClickHouseConfig } from "../config/schemas/compaction-logs.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("compaction-log-store");

export type CompactionStartEvent = Extract<
  AgentEvent,
  { type: "context_compacting" }
>;
export type CompactionEndEvent = Extract<
  AgentEvent,
  { type: "compaction_completed" }
>;

/** Cap stored summary text so a pathological summary can't bloat rows. */
const SUMMARY_TEXT_MAX_CHARS = 4000;

/**
 * Wire row written as one JSONEachRow line. Sentinels follow the
 * llm_request_logs mirror convention: ClickHouse columns are non-Nullable,
 * so `''` means "not set" for strings and `-1` means "unknown" for counts
 * that only exist on one phase of the pair.
 */
interface CompactionLogRow {
  assistant_id: string;
  conversation_id: string;
  compaction_id: string;
  request_id: string;
  phase: "start" | "end";
  trigger: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  pre_message_count: number;
  result_message_count: number;
  compacted: number;
  previous_estimated_input_tokens: number;
  estimated_input_tokens: number;
  max_input_tokens: number;
  threshold_tokens: number;
  compacted_messages: number;
  compacted_persisted_messages: number;
  preserved_tail_messages: number;
  summary_calls: number;
  summary_input_tokens: number;
  summary_output_tokens: number;
  summary_model: string;
  summary_failed: number;
  reason: string;
  exhausted: number;
  injection_mode: string;
  auto_compress_applied: number;
  summary_text: string;
}

async function readCredentialOrNull(
  service: string,
  field: string,
): Promise<string | null> {
  const value = await getSecureKeyAsync(credentialKey(service, field));
  return value ?? null;
}

/**
 * One compaction attempt, reconstructed from its start/end row pair.
 * `null` means the value isn't known — either the field belongs to the
 * other phase's row, the attempt never completed, or the stored value was
 * the column's sentinel.
 */
export interface CompactionLogEvent {
  compactionId: string;
  requestId: string;
  trigger: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  preMessageCount: number | null;
  resultMessageCount: number | null;
  compacted: boolean | null;
  previousEstimatedInputTokens: number | null;
  estimatedInputTokens: number | null;
  maxInputTokens: number | null;
  thresholdTokens: number | null;
  compactedMessages: number | null;
  compactedPersistedMessages: number | null;
  preservedTailMessages: number | null;
  summaryCalls: number | null;
  summaryInputTokens: number | null;
  summaryOutputTokens: number | null;
  summaryModel: string | null;
  summaryFailed: boolean | null;
  reason: string | null;
  exhausted: boolean | null;
  injectionMode: string | null;
  autoCompressApplied: boolean | null;
  summaryText: string | null;
  /** True when the end row exists — the attempt ran to completion. */
  completed: boolean;
}

/** Injectable fetch override for tests. Defaults to globalThis.fetch. */
export type CompactionLogFetch = typeof fetch;

export interface ClickHouseCompactionLogStoreDeps {
  /** Override the credential read for `clickhouse:url`. */
  resolveUrl?: () => Promise<string | null>;
  /** Override the credential read for `clickhouse:password`. */
  resolvePassword?: () => Promise<string | null>;
  /** Override the credential read for `vellum:platform_assistant_id`. */
  resolveAssistantId?: () => Promise<string | null>;
  /** Override fetch for testing. */
  fetchImpl?: CompactionLogFetch;
}

export class ClickHouseCompactionLogStore {
  private cachedUrl: string | null = null;
  private cachedPassword: string | null = null;
  private cachedAssistantId: string | null = null;
  private ensureTablePromise: Promise<void> | null = null;

  private readonly resolveUrl: () => Promise<string | null>;
  private readonly resolvePassword: () => Promise<string | null>;
  private readonly resolveAssistantId: () => Promise<string | null>;
  private readonly fetchImpl: CompactionLogFetch;

  constructor(
    private readonly config: CompactionLogsClickHouseConfig,
    deps: ClickHouseCompactionLogStoreDeps = {},
  ) {
    this.resolveUrl =
      deps.resolveUrl ?? (() => readCredentialOrNull("clickhouse", "url"));
    this.resolvePassword =
      deps.resolvePassword ??
      (() => readCredentialOrNull("clickhouse", "password"));
    this.resolveAssistantId =
      deps.resolveAssistantId ??
      (() => readCredentialOrNull("vellum", "platform_assistant_id"));
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async writeStart(
    conversationId: string,
    event: CompactionStartEvent,
  ): Promise<void> {
    await this.insert({
      ...emptyRow(await this.assistantId(), conversationId, event),
      phase: "start",
      pre_message_count: event.messages.length,
    });
  }

  async writeEnd(
    conversationId: string,
    event: CompactionEndEvent,
  ): Promise<void> {
    await this.insert({
      ...emptyRow(await this.assistantId(), conversationId, event),
      phase: "end",
      finished_at: event.finishedAt,
      duration_ms: event.finishedAt - event.startedAt,
      result_message_count: event.messages.length,
      compacted: event.compacted ? 1 : 0,
      previous_estimated_input_tokens: event.previousEstimatedInputTokens,
      estimated_input_tokens: event.estimatedInputTokens,
      max_input_tokens: event.maxInputTokens,
      threshold_tokens: event.thresholdTokens,
      compacted_messages: event.compactedMessages,
      compacted_persisted_messages: event.compactedPersistedMessages,
      preserved_tail_messages: event.preservedTailMessages ?? -1,
      summary_calls: event.summaryCalls,
      summary_input_tokens: event.summaryInputTokens,
      summary_output_tokens: event.summaryOutputTokens,
      summary_model: event.summaryModel,
      summary_failed:
        event.summaryFailed === undefined ? -1 : event.summaryFailed ? 1 : 0,
      reason: event.reason ?? "",
      exhausted: event.exhausted ? 1 : 0,
      injection_mode: event.injectionMode ?? "",
      auto_compress_applied: event.autoCompressApplied ? 1 : 0,
      summary_text: event.summaryText.slice(0, SUMMARY_TEXT_MAX_CHARS),
    });
  }

  /**
   * Read all compaction attempts whose `started_at` falls strictly inside
   * the open window `(afterStartedAt, beforeStartedAt)`, pairing start/end
   * rows by `compaction_id`. Mirrors the strict `>` / `<` predicate
   * contract of `getCompactionLogsBetween` on the llm-request-log sources
   * so the compaction route can scope both stores to the same call window
   * (floor = previous real call's `createdAt`, ceiling = selected call's
   * `createdAt`).
   */
  async getEventsBetween(
    conversationId: string,
    afterStartedAt: number | null,
    beforeStartedAt: number,
  ): Promise<CompactionLogEvent[]> {
    const params: Record<string, string> = {
      assistant_id: await this.assistantId(),
      conversation_id: conversationId,
      before_started_at: String(beforeStartedAt),
    };
    // Type-bound parameter slots referenced in the SQL but unbound at exec
    // time return a server error, so the floor predicate is only templated
    // in when the caller has one.
    let afterPredicate = "";
    if (afterStartedAt !== null) {
      params.after_started_at = String(afterStartedAt);
      afterPredicate =
        " AND started_at > fromUnixTimestamp64Milli({after_started_at:Int64})";
    }
    const sql = `SELECT
        compaction_id,
        request_id,
        phase,
        trigger,
        toUnixTimestamp64Milli(started_at) AS started_at,
        toUnixTimestamp64Milli(finished_at) AS finished_at,
        duration_ms,
        pre_message_count,
        result_message_count,
        compacted,
        previous_estimated_input_tokens,
        estimated_input_tokens,
        max_input_tokens,
        threshold_tokens,
        compacted_messages,
        compacted_persisted_messages,
        preserved_tail_messages,
        summary_calls,
        summary_input_tokens,
        summary_output_tokens,
        summary_model,
        summary_failed,
        reason,
        exhausted,
        injection_mode,
        auto_compress_applied,
        summary_text
      FROM ${this.tableRef()}
      WHERE assistant_id = {assistant_id:String}
        AND conversation_id = {conversation_id:String}
        AND started_at < fromUnixTimestamp64Milli({before_started_at:Int64})${afterPredicate}
      ORDER BY started_at ASC, created_at ASC
      LIMIT 1 BY compaction_id, phase
      FORMAT JSONEachRow`;
    const text = await this.exec(sql, undefined, params);
    const rows: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      rows.push(JSON.parse(trimmed) as Record<string, unknown>);
    }
    return pairRowsIntoEvents(rows);
  }

  private async insert(row: CompactionLogRow): Promise<void> {
    await this.ensureTable();
    await this.exec(
      `INSERT INTO ${this.tableRef()} FORMAT JSONEachRow`,
      JSON.stringify(row),
    );
  }

  /**
   * Create the table on first write so opting in is self-serve. Idempotent
   * (`IF NOT EXISTS`) and memoized per writer instance; a rejected attempt
   * clears the memo so the next write retries.
   */
  private ensureTable(): Promise<void> {
    if (!this.ensureTablePromise) {
      this.ensureTablePromise = this.exec(
        `CREATE TABLE IF NOT EXISTS ${this.tableRef()} (
          assistant_id String,
          conversation_id String,
          compaction_id String,
          request_id String,
          phase String,
          trigger String,
          started_at DateTime64(3),
          finished_at DateTime64(3),
          duration_ms Int64,
          pre_message_count Int64,
          result_message_count Int64,
          compacted UInt8,
          previous_estimated_input_tokens Int64,
          estimated_input_tokens Int64,
          max_input_tokens Int64,
          threshold_tokens Int64,
          compacted_messages Int64,
          compacted_persisted_messages Int64,
          preserved_tail_messages Int64,
          summary_calls Int64,
          summary_input_tokens Int64,
          summary_output_tokens Int64,
          summary_model String,
          summary_failed Int8,
          reason String,
          exhausted UInt8,
          injection_mode String,
          auto_compress_applied UInt8,
          summary_text String,
          created_at DateTime64(3) DEFAULT now64(3)
        ) ENGINE = MergeTree
        ORDER BY (assistant_id, conversation_id, started_at, compaction_id)`,
      ).then(
        () => undefined,
        (err: unknown) => {
          this.ensureTablePromise = null;
          throw err;
        },
      );
    }
    return this.ensureTablePromise;
  }

  private tableRef(): string {
    // Database is set via the `database=` URL param in `exec`, so only the
    // table identifier needs quoting. Backtick-quote to tolerate
    // non-default names with special characters.
    return `\`${this.config.table.replace(/`/g, "``")}\``;
  }

  private async exec(
    sql: string,
    body?: string,
    params?: Record<string, string>,
  ): Promise<string> {
    const baseUrl = await this.url();
    const password = await this.password();

    let target: URL;
    try {
      target = new URL(baseUrl);
    } catch (err) {
      throw new Error(
        `clickhouse:url is not a valid URL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    target.searchParams.set("database", this.config.database);
    for (const [k, v] of Object.entries(params ?? {})) {
      target.searchParams.set(`param_${k}`, v);
    }
    // For INSERTs the statement goes in the `query` param and the row data
    // in the body; DDL ships as the body itself.
    // Integer timestamps land correctly in DateTime64(3) columns: ClickHouse
    // treats integers inserted into DateTime64 as appropriately scaled Unix
    // timestamps, so epoch-millis map 1:1 at scale 3.
    if (body !== undefined) {
      target.searchParams.set("query", sql);
    }

    const auth =
      "Basic " +
      Buffer.from(`${this.config.user}:${password}`, "utf8").toString("base64");

    const res = await this.fetchImpl(target.toString(), {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "text/plain" },
      body: body ?? sql,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `ClickHouse compaction-log request failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
      );
    }
    return res.text();
  }

  private async assistantId(): Promise<string> {
    if (this.cachedAssistantId) return this.cachedAssistantId;
    const val = await this.resolveAssistantId();
    if (!val) {
      throw new Error(
        "vellum:platform_assistant_id credential is required when compactionLogs.destination=clickhouse",
      );
    }
    this.cachedAssistantId = val;
    return val;
  }

  private async url(): Promise<string> {
    if (this.cachedUrl) return this.cachedUrl;
    const val = await this.resolveUrl();
    if (!val) {
      throw new Error(
        "clickhouse:url credential is required when compactionLogs.destination=clickhouse",
      );
    }
    this.cachedUrl = val;
    return val;
  }

  private async password(): Promise<string> {
    if (this.cachedPassword) return this.cachedPassword;
    const val = await this.resolvePassword();
    if (!val) {
      throw new Error(
        "clickhouse:password credential is required when compactionLogs.destination=clickhouse",
      );
    }
    this.cachedPassword = val;
    return val;
  }
}

/** Shared row scaffold with phase-dependent fields at their sentinels. */
function emptyRow(
  assistantId: string,
  conversationId: string,
  event: CompactionStartEvent | CompactionEndEvent,
): CompactionLogRow {
  return {
    assistant_id: assistantId,
    conversation_id: conversationId,
    compaction_id: event.compactionId,
    request_id: event.requestId,
    phase: "start",
    trigger: event.trigger,
    started_at: event.startedAt,
    finished_at: 0,
    duration_ms: -1,
    pre_message_count: -1,
    result_message_count: -1,
    compacted: 0,
    previous_estimated_input_tokens: -1,
    estimated_input_tokens: -1,
    max_input_tokens: -1,
    threshold_tokens: -1,
    compacted_messages: -1,
    compacted_persisted_messages: -1,
    preserved_tail_messages: -1,
    summary_calls: -1,
    summary_input_tokens: -1,
    summary_output_tokens: -1,
    summary_model: "",
    summary_failed: -1,
    reason: "",
    exhausted: 0,
    injection_mode: "",
    auto_compress_applied: 0,
    summary_text: "",
  };
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/** Map the `-1` "unknown count" column sentinel back to null. */
function countOrNull(value: unknown): number | null {
  const n = num(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Map the `''` "not set" string column sentinel back to null. */
function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Pair raw start/end rows by `compaction_id` into per-attempt events.
 * Start-only pairs (the attempt never completed) surface with end-phase
 * fields null and `completed: false`.
 */
function pairRowsIntoEvents(
  rows: Record<string, unknown>[],
): CompactionLogEvent[] {
  const byId = new Map<
    string,
    { start?: Record<string, unknown>; end?: Record<string, unknown> }
  >();
  for (const row of rows) {
    const id = String(row.compaction_id);
    const pair = byId.get(id) ?? {};
    if (row.phase === "end") pair.end = row;
    else pair.start = row;
    byId.set(id, pair);
  }
  const events: CompactionLogEvent[] = [];
  for (const [compactionId, { start, end }] of byId) {
    const base = end ?? start;
    if (!base) continue;
    events.push({
      compactionId,
      requestId: String(base.request_id ?? ""),
      trigger: String(base.trigger ?? ""),
      startedAt: num(base.started_at),
      finishedAt: end ? num(end.finished_at) : null,
      durationMs: end ? countOrNull(end.duration_ms) : null,
      preMessageCount: start ? countOrNull(start.pre_message_count) : null,
      resultMessageCount: end ? countOrNull(end.result_message_count) : null,
      compacted: end ? num(end.compacted) === 1 : null,
      previousEstimatedInputTokens: end
        ? countOrNull(end.previous_estimated_input_tokens)
        : null,
      estimatedInputTokens: end
        ? countOrNull(end.estimated_input_tokens)
        : null,
      maxInputTokens: end ? countOrNull(end.max_input_tokens) : null,
      thresholdTokens: end ? countOrNull(end.threshold_tokens) : null,
      compactedMessages: end ? countOrNull(end.compacted_messages) : null,
      compactedPersistedMessages: end
        ? countOrNull(end.compacted_persisted_messages)
        : null,
      preservedTailMessages: end
        ? countOrNull(end.preserved_tail_messages)
        : null,
      summaryCalls: end ? countOrNull(end.summary_calls) : null,
      summaryInputTokens: end ? countOrNull(end.summary_input_tokens) : null,
      summaryOutputTokens: end ? countOrNull(end.summary_output_tokens) : null,
      summaryModel: end ? strOrNull(end.summary_model) : null,
      summaryFailed:
        end && num(end.summary_failed) !== -1
          ? num(end.summary_failed) === 1
          : null,
      reason: end ? strOrNull(end.reason) : null,
      exhausted: end ? num(end.exhausted) === 1 : null,
      injectionMode: end ? strOrNull(end.injection_mode) : null,
      autoCompressApplied: end ? num(end.auto_compress_applied) === 1 : null,
      summaryText: end ? strOrNull(end.summary_text) : null,
      completed: end !== undefined,
    });
  }
  return events.sort(
    (a, b) =>
      a.startedAt - b.startedAt || a.compactionId.localeCompare(b.compactionId),
  );
}

/**
 * Store cache keyed by the serialized connection config so config edits
 * take effect on the next event without restarting, while steady-state
 * writes reuse one instance (and its cached credentials / ensured table).
 */
let cachedStore: {
  key: string;
  store: ClickHouseCompactionLogStore;
} | null = null;

/**
 * Resolve the configured ClickHouse compaction log store, or null when
 * `compactionLogs.destination` is not `"clickhouse"`.
 */
export function getCompactionLogStore(): ClickHouseCompactionLogStore | null {
  const cfg = getConfig().compactionLogs;
  if (!cfg || cfg.destination !== "clickhouse") return null;
  const key = JSON.stringify(cfg.clickhouse);
  if (!cachedStore || cachedStore.key !== key) {
    cachedStore = {
      key,
      store: new ClickHouseCompactionLogStore(cfg.clickhouse),
    };
  }
  return cachedStore.store;
}

/** Test hook: drop the memoized store so config/dep changes are picked up. */
export function resetCompactionLogStoreForTests(): void {
  cachedStore = null;
}

/**
 * Record a compaction start event. Fire-and-forget: resolves immediately
 * when logging is disabled and never throws.
 */
export function recordCompactionStartBestEffort(
  conversationId: string,
  event: CompactionStartEvent,
): void {
  const store = getCompactionLogStore();
  if (!store) return;
  store.writeStart(conversationId, event).catch((err: unknown) => {
    log.warn(
      { err, conversationId, compactionId: event.compactionId },
      "Failed to write compaction start log (non-fatal)",
    );
  });
}

/**
 * Record a compaction end event. Fire-and-forget: resolves immediately
 * when logging is disabled and never throws.
 */
export function recordCompactionEndBestEffort(
  conversationId: string,
  event: CompactionEndEvent,
): void {
  const store = getCompactionLogStore();
  if (!store) return;
  store.writeEnd(conversationId, event).catch((err: unknown) => {
    log.warn(
      { err, conversationId, compactionId: event.compactionId },
      "Failed to write compaction end log (non-fatal)",
    );
  });
}
