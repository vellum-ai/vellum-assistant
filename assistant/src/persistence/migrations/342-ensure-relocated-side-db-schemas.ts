import { Database } from "bun:sqlite";

import { getTelemetryDbPath } from "../../util/telemetry-db-path.js";
import {
  type DrizzleDb,
  getLogsSqlite,
  getMemorySqlite,
  getTelemetrySqlite,
} from "../db-connection.js";
import { ensureLlmRequestLogsSchema } from "./297-move-llm-request-logs-to-logs-db.js";
import { ensureMemoryJobsSchema } from "./298-move-memory-jobs-to-memory-db.js";
import { migrateLlmRequestLogLatencyBreakdown } from "./310-llm-request-log-latency-breakdown.js";
import { ensureInjectionEventsSchema } from "./326-move-injection-events-to-memory-db.js";
import { ensureFlushCheckpointsSchema } from "./327-create-flush-checkpoints.js";
import { ensureTelemetryEventsSchema } from "./333-create-telemetry-events-table.js";
import { ensureActivationLogsSchema } from "./336-move-memory-v2-activation-logs-to-memory-db.js";
import { ensureRecallLogsSchema } from "./337-move-memory-recall-logs-to-memory-db.js";
import { ensureMemoryV3SelectionsSchema } from "./338-move-memory-v3-selections-to-memory-db.js";
import { ensureActivationSessionsSchema } from "./339-move-activation-sessions-to-memory-db.js";

/**
 * Recreate every migration-owned side-DB schema that an imported database may
 * be missing.
 *
 * A vbundle import (or warm-pool claim) carries the main `assistant.db` —
 * including its migration bookkeeping — but not the side databases
 * (`assistant-logs.db`, `assistant-memory.db`, `assistant-telemetry.db`). When
 * the imported bookkeeping already contains the relocation steps (297, 298,
 * 326, 327, 333, 336–339) they never re-run on the new machine, so the
 * freshly-created side DBs lack the relocated tables — and because the
 * dedicated connections perform no DDL on open, nothing else recreates them.
 * The in-body self-heals in later migrations only fire while those steps are
 * still pending; a bundle exported from a fully current assistant skips them
 * too, and the runtime stores then fail with `no such table`.
 *
 * This step is the backstop for that case: it re-runs each side DB's exported
 * ensure-schema functions, bringing every side-DB table to its current shape
 * (for `llm_request_logs` that includes migration 310's `latency_breakdown`
 * column, applied via 310's own idempotent, self-healing body). All DDL is
 * `IF NOT EXISTS`, so on a healthy database the whole step is a no-op.
 *
 * The legacy per-type telemetry tables migration 334 drops are deliberately
 * NOT recreated — post-334 the outbox (`telemetry_events`) is the only
 * telemetry event store.
 *
 * Throws when the logs or memory database cannot be opened — mirroring the
 * relocations — so the runner records the step as failed and retries on a
 * later boot instead of checkpointing it with the schemas still missing. The
 * telemetry DB uses the telemetry migrations' fail-soft direct open instead.
 */
export function migrateEnsureRelocatedSideDbSchemas(
  _database: DrizzleDb,
): void {
  const logsRaw = getLogsSqlite();
  if (!logsRaw) {
    throw new Error(
      "logs database unavailable — deferring side-DB schema ensure",
    );
  }
  ensureLlmRequestLogsSchema(logsRaw);
  migrateLlmRequestLogLatencyBreakdown();

  const memoryRaw = getMemorySqlite();
  if (!memoryRaw) {
    throw new Error(
      "memory database unavailable — deferring side-DB schema ensure",
    );
  }
  ensureMemoryJobsSchema(memoryRaw);
  ensureInjectionEventsSchema(memoryRaw);
  ensureActivationLogsSchema(memoryRaw);
  ensureRecallLogsSchema(memoryRaw);
  ensureMemoryV3SelectionsSchema(memoryRaw);
  ensureActivationSessionsSchema(memoryRaw);

  let telemetryRaw: Database | null = getTelemetrySqlite();
  if (!telemetryRaw) {
    // The dedicated connection failed to open (logged by openDedicatedDb).
    // Fall back to opening the file directly so the migration still runs —
    // the singleton will pick it up on a later access. This mirrors the
    // fail-soft pattern of the other telemetry-DB migrations.
    telemetryRaw = new Database(getTelemetryDbPath());
  }
  ensureFlushCheckpointsSchema(telemetryRaw);
  ensureTelemetryEventsSchema(telemetryRaw);
}
