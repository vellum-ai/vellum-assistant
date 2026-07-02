/**
 * ClickHouse-backed LLM request log read source.
 *
 * Reads from the ClickHouse mirror (populated out-of-band by the
 * `mirror-llm-logs-to-clickhouse` cron). Scoped to the running
 * assistant's own `assistant_id` — never cross-assistant. URL and
 * password are resolved lazily from the credential store
 * (`clickhouse:url`, `clickhouse:password`); database/table/user come
 * from workspace config.
 *
 * Known limitation: the mirror is INSERT-only. A row inserted locally
 * with `message_id = NULL` and backfilled later will appear in
 * ClickHouse with `message_id = ''` forever. Reads via this source for
 * the most-recent ~minute of activity therefore have lower fidelity
 * than the local source. Acceptable for the "internal use while we
 * finetune prompts" use case; revisit when mirror updates are added.
 */
import type { LlmRequestLogsClickHouseConfig } from "../config/schemas/llm-request-logs.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import {
  getAssistantMessageIdsInTurn,
  getMessageById,
  messageMetadataSchema,
} from "./conversation-crud.js";
import type { LlmRequestLogSource } from "./llm-request-log-source.js";
import type {
  CompactionAgentLogRow,
  LogMetaRow,
  LogRow,
} from "./llm-request-log-store.js";

const log = getLogger("clickhouse-llm-request-log-source");

/**
 * Read a credential and normalize `undefined` → `null`. The credential
 * resolver factories on this class are typed `() => Promise<string | null>`;
 * `getSecureKeyAsync` returns `Promise<string | undefined>`. Keep the
 * coercion in one place so TypeScript stays happy without per-call casts.
 */
async function readCredentialOrNull(
  service: string,
  field: string,
): Promise<string | null> {
  const value = await getSecureKeyAsync(credentialKey(service, field));
  return value ?? null;
}

/**
 * Wire-format row returned by ClickHouse for our query columns. Note
 * that `created_at` arrives as a string because Int64 is emitted as a
 * quoted string under the default `output_format_json_quote_64bit_integers=1`
 * setting; we coerce to `number` in `toLogRow`.
 */
interface ClickHouseRow {
  id: string;
  conversation_id: string;
  message_id: string;
  provider: string;
  request_payload: string;
  response_payload: string;
  created_at: string;
  agent_loop_exit_reason: string;
  /**
   * Mirrors `llm_request_logs.call_site` from the SQLite source. Added
   * to the CH `default.llm_request_logs` table via ALTER TABLE (matching
   * the `agent_loop_exit_reason` precedent — see
   * `memory/concepts/objects/clickhouse-mirror.md`).
   *
   * CH columns are `DEFAULT ''` rather than Nullable, so empty-string
   * means "not set" — `toLogRow` maps that back to NULL on the JS side.
   */
  call_site: string;
}

/** Metadata-only wire row — `ClickHouseRow` without the payload columns. */
type ClickHouseMetaRow = Omit<
  ClickHouseRow,
  "request_payload" | "response_payload"
>;

/**
 * Wire row for the compaction-trail query: metadata plus the summarizer
 * response payload and a message count computed server-side. ClickHouse's
 * `JSONLength` returns 0 for missing/invalid paths; `exec` callers map the
 * `nullif(…, 0)` result, so the field arrives as `number | null`.
 */
type ClickHouseCompactionRow = ClickHouseMetaRow & {
  response_payload: string;
  request_message_count: number | string | null;
};

/** Injectable fetch override for tests. Defaults to globalThis.fetch. */
export type ClickHouseFetch = typeof fetch;

/** Minimal subset of the SQLite message row the fork-source fallback needs. */
export interface ClickHouseMessageRow {
  metadata: string | null;
}

export interface ClickHouseLlmRequestLogSourceDeps {
  /** Override the credential read for `clickhouse:url`. */
  resolveUrl?: () => Promise<string | null>;
  /** Override the credential read for `clickhouse:password`. */
  resolvePassword?: () => Promise<string | null>;
  /** Override the credential read for `vellum:platform_assistant_id`. */
  resolveAssistantId?: () => Promise<string | null>;
  /** Override the turn-id resolver (default: `getAssistantMessageIdsInTurn`). */
  resolveTurnMessageIds?: (messageId: string) => string[];
  /** Override the message lookup (default: `getMessageById`). */
  resolveMessage?: (messageId: string) => ClickHouseMessageRow | null;
  /** Override fetch for testing. */
  fetchImpl?: ClickHouseFetch;
}

export class ClickHouseLlmRequestLogSource implements LlmRequestLogSource {
  private cachedUrl: string | null = null;
  private cachedPassword: string | null = null;
  private cachedAssistantId: string | null = null;

  private readonly resolveUrl: () => Promise<string | null>;
  private readonly resolvePassword: () => Promise<string | null>;
  private readonly resolveAssistantId: () => Promise<string | null>;
  private readonly resolveTurnMessageIds: (messageId: string) => string[];
  private readonly resolveMessage: (
    messageId: string,
  ) => ClickHouseMessageRow | null;
  private readonly fetchImpl: ClickHouseFetch;

  constructor(
    private readonly config: LlmRequestLogsClickHouseConfig,
    deps: ClickHouseLlmRequestLogSourceDeps = {},
  ) {
    this.resolveUrl =
      deps.resolveUrl ?? (() => readCredentialOrNull("clickhouse", "url"));
    this.resolvePassword =
      deps.resolvePassword ??
      (() => readCredentialOrNull("clickhouse", "password"));
    this.resolveAssistantId =
      deps.resolveAssistantId ??
      (() => readCredentialOrNull("vellum", "platform_assistant_id"));
    this.resolveTurnMessageIds =
      deps.resolveTurnMessageIds ?? getAssistantMessageIdsInTurn;
    this.resolveMessage = deps.resolveMessage ?? getMessageById;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getRequestLogById(logId: string): Promise<LogRow | null> {
    const aid = await this.assistantId();
    const sql = `SELECT
        id,
        conversation_id,
        message_id,
        provider,
        request_payload,
        response_payload,
        toUnixTimestamp64Milli(created_at) AS created_at,
        agent_loop_exit_reason,
        call_site
      FROM ${this.tableRef()}
      WHERE assistant_id = {assistant_id:String}
        AND id = {log_id:String}
      ORDER BY created_at DESC
      LIMIT 1
      FORMAT JSONEachRow`;
    const rows = await this.exec<ClickHouseRow>(sql, {
      assistant_id: aid,
      log_id: logId,
    });
    return rows[0] ? this.toLogRow(rows[0]) : null;
  }

  async getRequestLogMetaById(logId: string): Promise<LogMetaRow | null> {
    const aid = await this.assistantId();
    const sql = `SELECT
        id,
        conversation_id,
        message_id,
        provider,
        toUnixTimestamp64Milli(created_at) AS created_at,
        agent_loop_exit_reason,
        call_site
      FROM ${this.tableRef()}
      WHERE assistant_id = {assistant_id:String}
        AND id = {log_id:String}
      ORDER BY created_at DESC
      LIMIT 1
      FORMAT JSONEachRow`;
    const rows = await this.exec<ClickHouseMetaRow>(sql, {
      assistant_id: aid,
      log_id: logId,
    });
    return rows[0] ? this.toLogMetaRow(rows[0]) : null;
  }

  async getRequestLogsByMessageId(messageId: string): Promise<LogRow[]> {
    const turnIds = this.resolveTurnMessageIds(messageId);
    let rows = await this.selectByMessageIds(turnIds);

    if (rows.length === 0) {
      // Fork-source fallback. Mirror behavior of the local source: when no
      // logs match the queried message's turn, see if it was forked from
      // another and resolve that source's turn. The fork relationship lives
      // in local SQLite (message.metadata.forkSourceMessageId), not CH.
      const message = this.resolveMessage(messageId);
      if (message?.metadata) {
        try {
          const parsed = messageMetadataSchema.safeParse(
            JSON.parse(message.metadata),
          );
          const sourceMessageId =
            parsed.success &&
            typeof parsed.data.forkSourceMessageId === "string"
              ? parsed.data.forkSourceMessageId
              : null;
          if (sourceMessageId && sourceMessageId !== messageId) {
            const sourceTurnIds = this.resolveTurnMessageIds(sourceMessageId);
            rows = await this.selectByMessageIds(sourceTurnIds);
          }
        } catch {
          // metadata not JSON / schema mismatch — no fork fallback, return []
        }
      }
    }

    return rows.sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  }

  async getRequestLogsByConversationId(
    conversationId: string,
  ): Promise<LogRow[]> {
    const aid = await this.assistantId();
    const sql = `SELECT
        id,
        conversation_id,
        message_id,
        provider,
        request_payload,
        response_payload,
        toUnixTimestamp64Milli(created_at) AS created_at,
        agent_loop_exit_reason,
        call_site
      FROM ${this.tableRef()}
      WHERE assistant_id = {assistant_id:String}
        AND conversation_id = {conversation_id:String}
      ORDER BY created_at ASC, id ASC
      LIMIT 1 BY id
      FORMAT JSONEachRow`;
    const rows = await this.exec<ClickHouseRow>(sql, {
      assistant_id: aid,
      conversation_id: conversationId,
    });
    return rows.map((r) => this.toLogRow(r));
  }

  async getPreviousNonCompactionCallCreatedAt(
    conversationId: string,
    beforeCreatedAt: number,
  ): Promise<number | null> {
    const aid = await this.assistantId();
    // `call_site != 'compactionAgent'` keeps the pre-migration-264 rows
    // (stored as the empty-string default) in scope as real calls and
    // excludes only the summarizer's own logs, matching the local
    // store's `isNull(callSite) OR callSite != 'compactionAgent'`.
    const sql = `SELECT
        toUnixTimestamp64Milli(created_at) AS created_at
      FROM ${this.tableRef()}
      WHERE assistant_id = {assistant_id:String}
        AND conversation_id = {conversation_id:String}
        AND call_site != {call_site:String}
        AND created_at < fromUnixTimestamp64Milli({before_created_at:Int64})
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FORMAT JSONEachRow`;
    const rows = await this.exec<{ created_at: string }>(sql, {
      assistant_id: aid,
      conversation_id: conversationId,
      call_site: "compactionAgent",
      before_created_at: String(beforeCreatedAt),
    });
    return rows[0] ? Number(rows[0].created_at) : null;
  }

  async getCompactionLogsBetween(
    conversationId: string,
    afterCreatedAt: number | null,
    beforeCreatedAt: number,
  ): Promise<CompactionAgentLogRow[]> {
    const aid = await this.assistantId();
    // `call_site` is bound as a literal via type-bound parameter (not
    // string interpolation) for parity with the rest of this class —
    // even though "compactionAgent" is a hard-coded identifier today,
    // future call sites should plug into the same parameter slot
    // without re-templating the query string.
    //
    // The `afterCreatedAt` lower bound is appended dynamically because
    // type-bound parameter slots that are referenced in the SQL but
    // unbound at exec time return a server error — so we only template
    // the predicate in when the caller actually has a floor to enforce.
    const params: Record<string, string> = {
      assistant_id: aid,
      conversation_id: conversationId,
      call_site: "compactionAgent",
      before_created_at: String(beforeCreatedAt),
    };
    let afterPredicate = "";
    if (afterCreatedAt !== null) {
      params.after_created_at = String(afterCreatedAt);
      afterPredicate =
        " AND created_at > fromUnixTimestamp64Milli({after_created_at:Int64})";
    }
    // The request payload — an entire near-limit context window per
    // compaction — is never transferred: the trail only needs the count
    // of messages it contained, computed server-side across the three
    // provider shapes (`messages`, `contents`, `input`). `JSONLength`
    // returns 0 for missing paths or invalid JSON; `nullif` maps that
    // back to NULL.
    const sql = `SELECT
        id,
        conversation_id,
        message_id,
        provider,
        response_payload,
        nullif(greatest(
          JSONLength(request_payload, 'messages'),
          JSONLength(request_payload, 'contents'),
          JSONLength(request_payload, 'input')
        ), 0) AS request_message_count,
        toUnixTimestamp64Milli(created_at) AS created_at,
        agent_loop_exit_reason,
        call_site
      FROM ${this.tableRef()}
      WHERE assistant_id = {assistant_id:String}
        AND conversation_id = {conversation_id:String}
        AND call_site = {call_site:String}
        AND created_at < fromUnixTimestamp64Milli({before_created_at:Int64})${afterPredicate}
      ORDER BY created_at ASC, id ASC
      LIMIT 1 BY id
      FORMAT JSONEachRow`;
    const rows = await this.exec<ClickHouseCompactionRow>(sql, params);
    return rows.map((r) => ({
      ...this.toLogMetaRow(r),
      responsePayload: r.response_payload,
      requestMessageCount:
        r.request_message_count === null
          ? null
          : Number(r.request_message_count),
    }));
  }

  private async selectByMessageIds(ids: string[]): Promise<LogRow[]> {
    if (ids.length === 0) return [];
    const aid = await this.assistantId();
    // Bind each id as its own {id_N:String} placeholder. The IDs ultimately
    // come from a caller-supplied path parameter — `getAssistantMessageIdsInTurn`
    // passes the input straight through when the message lookup misses — so
    // inline literal building (even with quote-doubling) is unsafe: ClickHouse
    // honors `\'` as an escaped quote inside string literals, letting a
    // backslash-suffixed id break out of the IN clause and bypass the
    // `assistant_id` scope filter. Type-bound parameters carry value, not
    // syntax, regardless of content.
    const params: Record<string, string> = { assistant_id: aid };
    const placeholders: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const key = `id_${i}`;
      params[key] = ids[i]!;
      placeholders.push(`{${key}:String}`);
    }
    const sql = `SELECT
        id,
        conversation_id,
        message_id,
        provider,
        request_payload,
        response_payload,
        toUnixTimestamp64Milli(created_at) AS created_at,
        agent_loop_exit_reason,
        call_site
      FROM ${this.tableRef()}
      WHERE assistant_id = {assistant_id:String}
        AND message_id IN (${placeholders.join(",")})
      ORDER BY created_at ASC, id ASC
      LIMIT 1 BY id
      FORMAT JSONEachRow`;
    const rows = await this.exec<ClickHouseRow>(sql, params);
    return rows.map((r) => this.toLogRow(r));
  }

  private tableRef(): string {
    // Database is set via the `database=` URL param in `exec`, so we only
    // need to quote the table identifier here. Backtick-quote both to
    // tolerate non-default names with special characters.
    return `\`${this.config.table.replace(/`/g, "``")}\``;
  }

  private async exec<Row>(
    sql: string,
    params: Record<string, string>,
  ): Promise<Row[]> {
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
    for (const [k, v] of Object.entries(params)) {
      target.searchParams.set(`param_${k}`, v);
    }

    const auth =
      "Basic " +
      Buffer.from(`${this.config.user}:${password}`, "utf8").toString("base64");

    const res = await this.fetchImpl(target.toString(), {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "text/plain" },
      body: sql,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error(
        {
          status: res.status,
          table: this.config.table,
          bodySnippet: body.slice(0, 200),
        },
        "ClickHouse query failed",
      );
      throw new Error(
        `ClickHouse query failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
      );
    }

    const text = await res.text();
    if (text.trim().length === 0) return [];

    const rows: Row[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        rows.push(JSON.parse(trimmed) as Row);
      } catch (err) {
        throw new Error(
          `Failed to parse ClickHouse JSONEachRow line: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return rows;
  }

  private toLogRow(row: ClickHouseRow): LogRow {
    return {
      ...this.toLogMetaRow(row),
      requestPayload: row.request_payload,
      responsePayload: row.response_payload,
      // The ClickHouse mirror does not replicate `latency_breakdown` yet, so
      // ClickHouse-sourced rows carry no waterfall — the inspector falls back
      // to no latency card, exactly as for a pre-instrumentation row.
      latencyBreakdown: null,
    };
  }

  private toLogMetaRow(row: ClickHouseMetaRow): LogMetaRow {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      // The mirror writes empty-string for missing message_id/provider
      // because the CH table columns have `DEFAULT ''` (Nullable adds
      // overhead). Map empty back to null to match the local LogRow shape.
      messageId: row.message_id === "" ? null : row.message_id,
      provider: row.provider === "" ? null : row.provider,
      createdAt: Number(row.created_at),
      agentLoopExitReason:
        row.agent_loop_exit_reason === "" ? null : row.agent_loop_exit_reason,
      callSite: row.call_site === "" ? null : row.call_site,
    };
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
