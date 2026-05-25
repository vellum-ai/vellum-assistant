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
import type { LogRow } from "./llm-request-log-store.js";

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
    const rows = await this.exec(sql, { assistant_id: aid, log_id: logId });
    return rows[0] ? this.toLogRow(rows[0]) : null;
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
    const rows = await this.exec(sql, {
      assistant_id: aid,
      conversation_id: conversationId,
    });
    return rows.map((r) => this.toLogRow(r));
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
    const rows = await this.exec(sql, params);
    return rows.map((r) => this.toLogRow(r));
  }

  private tableRef(): string {
    // Database is set via the `database=` URL param in `exec`, so we only
    // need to quote the table identifier here. Backtick-quote both to
    // tolerate non-default names with special characters.
    return `\`${this.config.table.replace(/`/g, "``")}\``;
  }

  private async exec(
    sql: string,
    params: Record<string, string>,
  ): Promise<ClickHouseRow[]> {
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
        { status: res.status, table: this.config.table, bodySnippet: body.slice(0, 200) },
        "ClickHouse query failed",
      );
      throw new Error(
        `ClickHouse query failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
      );
    }

    const text = await res.text();
    if (text.trim().length === 0) return [];

    const rows: ClickHouseRow[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        rows.push(JSON.parse(trimmed) as ClickHouseRow);
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
      id: row.id,
      conversationId: row.conversation_id,
      // The mirror writes empty-string for missing message_id/provider
      // because the CH table columns have `DEFAULT ''` (Nullable adds
      // overhead). Map empty back to null to match the local LogRow shape.
      messageId: row.message_id === "" ? null : row.message_id,
      provider: row.provider === "" ? null : row.provider,
      requestPayload: row.request_payload,
      responsePayload: row.response_payload,
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
