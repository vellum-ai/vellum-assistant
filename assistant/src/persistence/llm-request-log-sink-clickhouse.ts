/**
 * ClickHouse-backed LLM request log WRITE sink.
 *
 * The counterpart to `llm-request-log-source-clickhouse.ts` (reads). When
 * `llmRequestLogs.readSource === "clickhouse"`, `recordRequestLog` writes
 * request/response rows directly here instead of the local SQLite
 * `llm_request_logs` table — so ClickHouse is the source of truth for the
 * write, not a downstream mirror.
 *
 * Wire shape matches what the read source expects (see
 * `llm-request-log-source-clickhouse.ts`): the same columns, scoped to the
 * running assistant's own `assistant_id`, with `''` string sentinels for
 * unset `message_id` / `provider` / `agent_loop_exit_reason` / `call_site`
 * (the read source maps `''` back to `null`). URL and password resolve from
 * the credential store (`clickhouse:url`, `clickhouse:password`);
 * database/table/user come from config. The table is created lazily with
 * `CREATE TABLE IF NOT EXISTS` on first write so opting in needs no
 * out-of-band DDL, and is a no-op against a table the mirror cron already
 * created.
 *
 * Known limitation, inherited from the ClickHouse mirror design: the sink is
 * INSERT-only. Post-write stamps that the local store applies to existing
 * rows — `setAgentLoopExitReasonOnLatestLog`, `backfillMessageIdOnLogs`,
 * `relinkLlmRequestLogs` — have no ClickHouse equivalent, so a row's
 * `agent_loop_exit_reason` / `message_id` reflect only what was known at
 * insert time. `latency_breakdown` is likewise not carried (the read source
 * already treats ClickHouse-sourced rows as having no latency waterfall).
 *
 * Writes are best-effort: a ClickHouse outage logs and is swallowed so it
 * can never abort a turn.
 */
import { getConfigReadOnly } from "../config/loader.js";
import type { LlmRequestLogsClickHouseConfig } from "../config/schemas/llm-request-logs.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import type {
  LlmRequestLogWriter,
  LlmRequestLogWriteRow,
} from "./llm-request-log-writer-types.js";

const log = getLogger("clickhouse-llm-request-log-sink");

/** Wire row written as one JSONEachRow line. */
interface ClickHouseInsertRow {
  assistant_id: string;
  id: string;
  conversation_id: string;
  message_id: string;
  provider: string;
  request_payload: string;
  response_payload: string;
  created_at: number;
  agent_loop_exit_reason: string;
  call_site: string;
}

async function readCredentialOrNull(
  service: string,
  field: string,
): Promise<string | null> {
  const value = await getSecureKeyAsync(credentialKey(service, field));
  return value ?? null;
}

/** Injectable fetch override for tests. Defaults to globalThis.fetch. */
export type ClickHouseSinkFetch = typeof fetch;

export interface ClickHouseLlmRequestLogSinkDeps {
  /** Override the credential read for `clickhouse:url`. */
  resolveUrl?: () => Promise<string | null>;
  /** Override the credential read for `clickhouse:password`. */
  resolvePassword?: () => Promise<string | null>;
  /** Override the credential read for `vellum:platform_assistant_id`. */
  resolveAssistantId?: () => Promise<string | null>;
  /** Override fetch for testing. */
  fetchImpl?: ClickHouseSinkFetch;
}

export class ClickHouseLlmRequestLogSink implements LlmRequestLogWriter {
  private cachedUrl: string | null = null;
  private cachedPassword: string | null = null;
  private cachedAssistantId: string | null = null;
  private ensureTablePromise: Promise<void> | null = null;

  private readonly resolveUrl: () => Promise<string | null>;
  private readonly resolvePassword: () => Promise<string | null>;
  private readonly resolveAssistantId: () => Promise<string | null>;
  private readonly fetchImpl: ClickHouseSinkFetch;

  constructor(
    private readonly config: LlmRequestLogsClickHouseConfig,
    deps: ClickHouseLlmRequestLogSinkDeps = {},
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

  /**
   * `LlmRequestLogWriter` insert. Fire-and-forget: returns immediately; the
   * write runs on a detached promise whose rejection is logged and swallowed
   * so a ClickHouse outage never propagates into the turn. Mirrors the
   * compaction-log store's best-effort recording contract.
   *
   * `latencyBreakdown` on the row is intentionally dropped — the ClickHouse
   * table doesn't carry that column, and the read source already treats
   * ClickHouse-sourced rows as having no latency waterfall.
   */
  insertRequestLog(row: LlmRequestLogWriteRow): void {
    this.insert(row).catch((err: unknown) => {
      log.warn(
        { err, conversationId: row.conversationId, callSite: row.callSite },
        "Failed to write LLM request log to ClickHouse (non-fatal)",
      );
    });
  }

  /**
   * No-op: this backend is INSERT-only, so a row's exit reason is whatever
   * was known at insert time (synthetic rows carry theirs; real calls stay
   * unstamped). Deliberately does NOT fall through to SQLite — the newest
   * NULL-reason local row would be a stale one from an earlier local-mode
   * turn, and stamping it would corrupt local history.
   */
  setAgentLoopExitReasonOnLatestLog(
    _conversationId: string,
    _reason: string,
  ): void {}

  /**
   * No-op: INSERT-only. The NULL-`message_id`-scoped backfill is a heuristic
   * over the write backend's own rows; running it against SQLite in
   * ClickHouse mode would stamp stale local rows with the wrong message.
   */
  backfillMessageIdOnLogs(_conversationId: string, _messageId: string): void {}

  /** No-op: INSERT-only — rows cannot be re-linked after the fact. */
  relinkLlmRequestLogs(_fromMessageIds: string[], _toMessageId: string): void {}

  /** No-op: INSERT-only — recovered-row backfill only applies to local rows. */
  backfillMessageIdOnRecoveredLogs(
    _logIds: string[],
    _messageId: string,
  ): void {}

  async insert(row: LlmRequestLogWriteRow): Promise<void> {
    const assistantId = await this.assistantId();
    await this.ensureTable();
    const wire: ClickHouseInsertRow = {
      assistant_id: assistantId,
      id: row.id,
      conversation_id: row.conversationId,
      // Non-Nullable columns use `''` for "unset"; the read source maps it back.
      message_id: row.messageId ?? "",
      provider: row.provider ?? "",
      request_payload: row.requestPayload,
      response_payload: row.responsePayload,
      created_at: row.createdAt,
      agent_loop_exit_reason: row.agentLoopExitReason ?? "",
      call_site: row.callSite ?? "",
    };
    await this.exec(
      `INSERT INTO ${this.tableRef()} FORMAT JSONEachRow`,
      JSON.stringify(wire),
    );
  }

  /**
   * Create the table on first write so opting in is self-serve. Idempotent
   * (`IF NOT EXISTS`, so a no-op against the mirror cron's existing table)
   * and memoized per instance; a rejected attempt clears the memo so the
   * next write retries.
   */
  private ensureTable(): Promise<void> {
    if (!this.ensureTablePromise) {
      this.ensureTablePromise = this.exec(
        `CREATE TABLE IF NOT EXISTS ${this.tableRef()} (
          assistant_id String,
          id String,
          conversation_id String,
          message_id String,
          provider String,
          request_payload String,
          response_payload String,
          created_at DateTime64(3),
          agent_loop_exit_reason String,
          call_site String
        ) ENGINE = MergeTree
        ORDER BY (assistant_id, conversation_id, created_at, id)`,
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
    // table identifier needs quoting. Backtick-quote to tolerate non-default
    // names with special characters.
    return `\`${this.config.table.replace(/`/g, "``")}\``;
  }

  private async exec(sql: string, body?: string): Promise<string> {
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
    // For INSERTs the statement goes in the `query` param and the row data in
    // the body; DDL ships as the body itself. ClickHouse treats integers
    // inserted into DateTime64(3) as epoch millis, so `created_at` maps 1:1.
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
        `ClickHouse llm-request-log write failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
      );
    }
    return res.text();
  }

  private async assistantId(): Promise<string> {
    if (this.cachedAssistantId) return this.cachedAssistantId;
    const val = await this.resolveAssistantId();
    if (!val) {
      throw new Error(
        "vellum:platform_assistant_id credential is required when readSource=clickhouse",
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
        "clickhouse:url credential is required when readSource=clickhouse",
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
        "clickhouse:password credential is required when readSource=clickhouse",
      );
    }
    this.cachedPassword = val;
    return val;
  }
}

/**
 * Sink cache keyed by the serialized connection config so config edits take
 * effect on the next write without a restart, while steady-state writes reuse
 * one instance (and its cached credentials / ensured table).
 */
let cachedSink: { key: string; sink: ClickHouseLlmRequestLogSink } | null =
  null;

/**
 * Resolve the configured ClickHouse write sink, or `null` when
 * `llmRequestLogs.readSource` is not `"clickhouse"` (i.e. writes stay on
 * local SQLite). Read-only config access keeps this off the disk-write path,
 * matching the write hot path's `getConfigReadOnly` usage. Returns `null` on
 * any config resolution error so a config hiccup falls back to SQLite rather
 * than dropping the write.
 */
export function getClickHouseLlmRequestLogSink(): ClickHouseLlmRequestLogSink | null {
  let cfg;
  try {
    cfg = getConfigReadOnly().llmRequestLogs;
  } catch {
    return null;
  }
  if (!cfg || cfg.readSource !== "clickhouse") return null;
  const key = JSON.stringify(cfg.clickhouse);
  if (!cachedSink || cachedSink.key !== key) {
    cachedSink = { key, sink: new ClickHouseLlmRequestLogSink(cfg.clickhouse) };
  }
  return cachedSink.sink;
}

/** Test hook: drop the memoized sink so config/dep changes are picked up. */
export function resetClickHouseLlmRequestLogSinkForTests(): void {
  cachedSink = null;
}
