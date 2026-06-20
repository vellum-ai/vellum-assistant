import { getConfig } from "../../config/loader.js";
import type {
  AnthropicCacheCreationTokenDetails,
  PricingUsage,
} from "../../usage/types.js";
import { getLogger } from "../../util/logger.js";
import { resolvePricingForUsageWithOverrides } from "../../util/pricing.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Reverse v20: no-op — cannot reliably identify which llm_usage_events rows
 * were updated by the backfill vs already had correct cache accounting.
 *
 * The forward migration updated input_tokens, output_tokens, cache token
 * columns, estimated_cost_usd, and pricing_status based on request logs.
 * There is no marker distinguishing backfilled rows from naturally-written
 * ones, so a reversal cannot be performed without risking data corruption.
 */
export function downBackfillUsageCacheAccounting(_database: DrizzleDb): void {
  // Lossy — cannot identify which rows were backfilled.
}

const log = getLogger("memory-db");

const CHECKPOINT_KEY = "migration_backfill_usage_cache_accounting_v1";

interface UsageEventRow {
  id: string;
  conversation_id: string | null;
  created_at: number;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

interface RequestLogRow {
  id: string;
  conversation_id: string;
  response_payload: string;
  created_at: number;
}

interface ReconstructedUsage extends PricingUsage {
  totalInputTokens: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value == null) return null;
  return value as Record<string, unknown>;
}

function parseRequiredTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

function parseOptionalTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(value, 0);
}

function parseResponseUsage(
  responsePayload: string,
): ReconstructedUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responsePayload);
  } catch {
    return null;
  }

  const payloads = Array.isArray(parsed) ? parsed : [parsed];
  if (payloads.length === 0) return null;

  let directInputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let ephemeral5mInputTokens = 0;
  let ephemeral1hInputTokens = 0;

  for (const payload of payloads) {
    const response = asRecord(payload);
    const usage = asRecord(response?.usage);
    if (!usage) return null;

    const inputTokens = parseRequiredTokenCount(usage.input_tokens);
    const responseOutputTokens = parseRequiredTokenCount(usage.output_tokens);
    if (inputTokens == null || responseOutputTokens == null) {
      return null;
    }

    const cacheReadTokens = parseOptionalTokenCount(
      usage.cache_read_input_tokens,
    );
    const cacheCreation = asRecord(usage.cache_creation);

    directInputTokens += inputTokens;
    outputTokens += responseOutputTokens;
    cacheReadInputTokens += cacheReadTokens;
    ephemeral5mInputTokens += parseOptionalTokenCount(
      cacheCreation?.ephemeral_5m_input_tokens,
    );
    ephemeral1hInputTokens += parseOptionalTokenCount(
      cacheCreation?.ephemeral_1h_input_tokens,
    );
  }

  const cacheCreationInputTokens =
    ephemeral5mInputTokens + ephemeral1hInputTokens;
  const anthropicCacheCreation: AnthropicCacheCreationTokenDetails | null =
    cacheCreationInputTokens > 0
      ? {
          ephemeral_5m_input_tokens: ephemeral5mInputTokens,
          ephemeral_1h_input_tokens: ephemeral1hInputTokens,
        }
      : null;

  return {
    directInputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    anthropicCacheCreation,
    totalInputTokens:
      directInputTokens + cacheCreationInputTokens + cacheReadInputTokens,
  };
}

function buildRequestLogMap(
  rows: RequestLogRow[],
): Map<string, RequestLogRow[]> {
  const requestLogsByConversation = new Map<string, RequestLogRow[]>();
  for (const row of rows) {
    const conversationRows =
      requestLogsByConversation.get(row.conversation_id) ?? [];
    conversationRows.push(row);
    requestLogsByConversation.set(row.conversation_id, conversationRows);
  }
  return requestLogsByConversation;
}

export function migrateBackfillUsageCacheAccounting(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const usageEventsTableExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage_events'`,
      )
      .get();
    const requestLogsTableExists = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'llm_request_logs'`,
      )
      .get();
    if (!usageEventsTableExists || !requestLogsTableExists) return;

    const usageRows = raw
      .query(
        /*sql*/ `
        SELECT
          id,
          conversation_id,
          created_at,
          provider,
          model,
          input_tokens,
          output_tokens,
          cache_creation_input_tokens,
          cache_read_input_tokens
        FROM llm_usage_events
        ORDER BY conversation_id ASC, created_at ASC, id ASC
        `,
      )
      .all() as UsageEventRow[];

    const requestLogRows = raw
      .query(
        /*sql*/ `
        SELECT
          id,
          conversation_id,
          response_payload,
          created_at
        FROM llm_request_logs
        ORDER BY conversation_id ASC, created_at ASC, id ASC
        `,
      )
      .all() as RequestLogRow[];

    const requestLogsByConversation = buildRequestLogMap(requestLogRows);
    const requestOffsets = new Map<string, number>();
    const previousUsageEventCreatedAt = new Map<string, number>();
    const pricingOverrides = getConfig().llm.pricingOverrides;

    let scannedAnthropicRows = 0;
    let updatedRows = 0;
    let skippedNoConversation = 0;
    let skippedNoLogs = 0;
    let ignoredUnusableLogs = 0;
    let skippedInconsistentRows = 0;

    const updateRow = raw.prepare(/*sql*/ `
      UPDATE llm_usage_events
      SET
        input_tokens = ?,
        output_tokens = ?,
        cache_creation_input_tokens = ?,
        cache_read_input_tokens = ?,
        estimated_cost_usd = ?,
        pricing_status = ?
      WHERE id = ?
      `);

    try {
      raw.exec("BEGIN");

      for (const usageRow of usageRows) {
        const conversationId = usageRow.conversation_id;
        if (conversationId == null) {
          if (usageRow.provider === "anthropic") {
            scannedAnthropicRows += 1;
            skippedNoConversation += 1;
          }
          continue;
        }

        const previousCreatedAt =
          previousUsageEventCreatedAt.get(conversationId) ?? null;
        const conversationRequestLogs =
          requestLogsByConversation.get(conversationId) ?? [];
        let requestOffset = requestOffsets.get(conversationId) ?? 0;
        const windowLogs: RequestLogRow[] = [];

        while (
          requestOffset < conversationRequestLogs.length &&
          conversationRequestLogs[requestOffset]!.created_at <=
            usageRow.created_at
        ) {
          const requestLog = conversationRequestLogs[requestOffset]!;
          if (
            previousCreatedAt == null ||
            requestLog.created_at > previousCreatedAt
          ) {
            windowLogs.push(requestLog);
          }
          requestOffset += 1;
        }

        requestOffsets.set(conversationId, requestOffset);
        previousUsageEventCreatedAt.set(conversationId, usageRow.created_at);

        if (usageRow.provider !== "anthropic") continue;

        scannedAnthropicRows += 1;
        if (windowLogs.length === 0) {
          skippedNoLogs += 1;
          continue;
        }

        let directInputTokens = 0;
        let outputTokens = 0;
        let cacheReadInputTokens = 0;
        let cacheCreationInputTokens = 0;
        let cacheCreation5mInputTokens = 0;
        let cacheCreation1hInputTokens = 0;
        let usableLogCount = 0;

        for (const requestLog of windowLogs) {
          const reconstructedUsage = parseResponseUsage(
            requestLog.response_payload,
          );
          if (!reconstructedUsage) {
            ignoredUnusableLogs += 1;
            continue;
          }
          usableLogCount += 1;
          directInputTokens += reconstructedUsage.directInputTokens;
          outputTokens += reconstructedUsage.outputTokens;
          cacheReadInputTokens += reconstructedUsage.cacheReadInputTokens;
          cacheCreationInputTokens +=
            reconstructedUsage.cacheCreationInputTokens;
          cacheCreation5mInputTokens +=
            reconstructedUsage.anthropicCacheCreation
              ?.ephemeral_5m_input_tokens ?? 0;
          cacheCreation1hInputTokens +=
            reconstructedUsage.anthropicCacheCreation
              ?.ephemeral_1h_input_tokens ?? 0;
        }

        if (usableLogCount === 0) {
          skippedNoLogs += 1;
          continue;
        }

        const totalInputTokens =
          directInputTokens + cacheCreationInputTokens + cacheReadInputTokens;
        const existingTotalInputTokens =
          Math.max(usageRow.input_tokens, 0) +
          Math.max(usageRow.cache_creation_input_tokens ?? 0, 0) +
          Math.max(usageRow.cache_read_input_tokens ?? 0, 0);

        // This lets the migration safely rewrite both flattened historical rows
        // and already-correct rows, while skipping mismatched request-log windows.
        if (
          totalInputTokens < 0 ||
          directInputTokens < 0 ||
          totalInputTokens !== existingTotalInputTokens ||
          outputTokens !== Math.max(usageRow.output_tokens, 0)
        ) {
          skippedInconsistentRows += 1;
          continue;
        }

        const pricingUsage: PricingUsage = {
          directInputTokens,
          outputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          anthropicCacheCreation:
            cacheCreationInputTokens > 0
              ? {
                  ephemeral_5m_input_tokens: cacheCreation5mInputTokens,
                  ephemeral_1h_input_tokens: cacheCreation1hInputTokens,
                }
              : null,
        };
        const pricing = resolvePricingForUsageWithOverrides(
          usageRow.provider,
          usageRow.model,
          pricingUsage,
          pricingOverrides,
        );

        updateRow.run(
          directInputTokens,
          outputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          pricing.estimatedCostUsd,
          pricing.pricingStatus,
          usageRow.id,
        );
        updatedRows += 1;
      }

      raw.exec("COMMIT");
    } catch (err) {
      raw.exec("ROLLBACK");
      throw err;
    }

    log.info(
      {
        scannedAnthropicRows,
        updatedRows,
        skippedNoConversation,
        skippedNoLogs,
        ignoredUnusableLogs,
        skippedInconsistentRows,
      },
      "Backfilled historical Anthropic usage rows from request-log accounting",
    );
  });
}
