/**
 * ClickHouse compaction log writer.
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
 * turn abort — are still visible), and an `end` row carries the full
 * `ContextWindowResult`. Consumers pair rows by `compaction_id`.
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

const log = getLogger("compaction-log-writer");

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
  basis_message_count: number;
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

/** Injectable fetch override for tests. Defaults to globalThis.fetch. */
export type CompactionLogFetch = typeof fetch;

export interface ClickHouseCompactionLogWriterDeps {
  /** Override the credential read for `clickhouse:url`. */
  resolveUrl?: () => Promise<string | null>;
  /** Override the credential read for `clickhouse:password`. */
  resolvePassword?: () => Promise<string | null>;
  /** Override the credential read for `vellum:platform_assistant_id`. */
  resolveAssistantId?: () => Promise<string | null>;
  /** Override fetch for testing. */
  fetchImpl?: CompactionLogFetch;
}

export class ClickHouseCompactionLogWriter {
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
    deps: ClickHouseCompactionLogWriterDeps = {},
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
    const r = event.result;
    await this.insert({
      ...emptyRow(await this.assistantId(), conversationId, event),
      phase: "end",
      finished_at: event.finishedAt,
      duration_ms: event.finishedAt - event.startedAt,
      basis_message_count: event.messages.length,
      compacted: r.compacted ? 1 : 0,
      previous_estimated_input_tokens: r.previousEstimatedInputTokens,
      estimated_input_tokens: r.estimatedInputTokens,
      max_input_tokens: r.maxInputTokens,
      threshold_tokens: r.thresholdTokens,
      compacted_messages: r.compactedMessages,
      compacted_persisted_messages: r.compactedPersistedMessages,
      preserved_tail_messages: r.preservedTailMessages ?? -1,
      summary_calls: r.summaryCalls,
      summary_input_tokens: r.summaryInputTokens,
      summary_output_tokens: r.summaryOutputTokens,
      summary_model: r.summaryModel,
      summary_failed:
        r.summaryFailed === undefined ? -1 : r.summaryFailed ? 1 : 0,
      reason: r.reason ?? "",
      exhausted: r.exhausted ? 1 : 0,
      injection_mode: r.injectionMode ?? "",
      auto_compress_applied: r.autoCompressApplied ? 1 : 0,
      summary_text: r.summaryText.slice(0, SUMMARY_TEXT_MAX_CHARS),
    });
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
          basis_message_count Int64,
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
      ).catch((err: unknown) => {
        this.ensureTablePromise = null;
        throw err;
      });
    }
    return this.ensureTablePromise;
  }

  private tableRef(): string {
    // Database is set via the `database=` URL param in `exec`, so only the
    // table identifier needs quoting. Backtick-quote to tolerate
    // non-default names with special characters.
    return `\`${this.config.table.replace(/`/g, "``")}\``;
  }

  private async exec(sql: string, body?: string): Promise<void> {
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
        `ClickHouse compaction-log write failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
      );
    }
    // Drain the body so the connection can be reused.
    await res.text().catch(() => "");
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
    basis_message_count: -1,
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

/**
 * Writer cache keyed by the serialized connection config so config edits
 * take effect on the next event without restarting, while steady-state
 * writes reuse one instance (and its cached credentials / ensured table).
 */
let cachedWriter: {
  key: string;
  writer: ClickHouseCompactionLogWriter;
} | null = null;

function getWriter(): ClickHouseCompactionLogWriter | null {
  const cfg = getConfig().compactionLogs;
  if (!cfg || cfg.destination !== "clickhouse") return null;
  const key = JSON.stringify(cfg.clickhouse);
  if (!cachedWriter || cachedWriter.key !== key) {
    cachedWriter = {
      key,
      writer: new ClickHouseCompactionLogWriter(cfg.clickhouse),
    };
  }
  return cachedWriter.writer;
}

/** Test hook: drop the memoized writer so config/dep changes are picked up. */
export function resetCompactionLogWriterForTests(): void {
  cachedWriter = null;
}

/**
 * Record a compaction start event. Fire-and-forget: resolves immediately
 * when logging is disabled and never throws.
 */
export function recordCompactionStartBestEffort(
  conversationId: string,
  event: CompactionStartEvent,
): void {
  const writer = getWriter();
  if (!writer) return;
  writer.writeStart(conversationId, event).catch((err: unknown) => {
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
  const writer = getWriter();
  if (!writer) return;
  writer.writeEnd(conversationId, event).catch((err: unknown) => {
    log.warn(
      { err, conversationId, compactionId: event.compactionId },
      "Failed to write compaction end log (non-fatal)",
    );
  });
}
