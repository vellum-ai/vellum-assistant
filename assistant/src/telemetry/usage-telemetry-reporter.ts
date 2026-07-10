/**
 * Usage telemetry reporter.
 *
 * Periodically flushes unreported telemetry events (LLM usage, turns,
 * lifecycle, ...) from the local SQLite databases and POSTs them to the
 * platform telemetry endpoint. Each event type is a
 * {@link TelemetryEventSource}; the reporter is a generic engine over the
 * source list it is constructed with, advancing one compound
 * `(createdAt, id)` watermark cursor per source in the telemetry DB's
 * `flush_checkpoints` table after each successful upload.
 *
 * Authenticated-only: events are sent via the managed proxy context
 * (Api-Key header). When no platform credentials are available, or when
 * platform features are disabled (VELLUM_DISABLE_PLATFORM in local mode), the
 * flush is skipped and retried next cycle.
 */

import { getPlatformOrganizationId, getPlatformUserId } from "../config/env.js";
import { VellumPlatformClient } from "../platform/client.js";
import { getCachedShareAnalytics } from "../platform/consent-cache.js";
import { arePlatformFeaturesEnabled } from "../platform/feature-gate.js";
import { getDeviceId } from "../util/device-id.js";
import { getLogger } from "../util/logger.js";
import { APP_VERSION } from "../version.js";
import {
  type FlushCheckpointStore,
  telemetryDbFlushCheckpointStore,
} from "./flush-checkpoints.js";
import {
  ALL_TELEMETRY_EVENT_SOURCES,
  type TelemetryEventSource,
  type TelemetryEventSourceBatch,
  TOOL_EXECUTED_SOURCE_ID,
  watermarkKeysForSource,
} from "./telemetry-event-sources.js";

const log = getLogger("usage-telemetry");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Written into the `*_id` watermark checkpoints by the opt-out flush branch.
// Sorts lexicographically above every real row ID (all event stores generate
// lowercase v4 UUIDs), so the compound cursor's same-millisecond arm
// (`createdAt == watermark AND id > afterId`) can never match an opt-out row.
const OPT_OUT_WATERMARK_ID_SENTINEL = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const REPORT_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_FLUSH_DELAY_MS = 30_000; // Delay first flush to let CES handshake complete
const BATCH_SIZE = 500;
const MAX_CONSECUTIVE_BATCHES = 10;
const TELEMETRY_PATH = "/v1/telemetry/ingest/";

// ---------------------------------------------------------------------------
// Singleton access
// ---------------------------------------------------------------------------

let _instance: UsageTelemetryReporter | null = null;

export function getUsageTelemetryReporter(): UsageTelemetryReporter | null {
  return _instance;
}

/**
 * Construct and start the singleton usage telemetry reporter. No-op in dev mode
 * (VELLUM_DEV=1) and idempotent if already started.
 *
 * Started even when share_analytics consent is opted out: flush() re-checks
 * consent each cycle and, when opted out, sends nothing but advances all
 * watermarks (including the final flush in stop()). New opted-out
 * tool_invocations rows are already unreportable by construction — the audit
 * listener persists NULL telemetry columns for them, which the tool_executed
 * projection filters out — so the opted-out flushes are defense in depth there
 * (covering rows recorded under builds that predate that write-time gate) and
 * remain the primary guard for the always-on tables without a write-time gate
 * (llm_usage, turn events). Not gated on DB readiness: getDb() can still work
 * when initializeDb() failed mid-migration, in which case the audit listener
 * keeps writing rows the opt-out branch must keep covered. The reporter is
 * degraded-mode safe — its constructor and flush() treat DB errors as non-fatal.
 */
export function startUsageTelemetryReporter(): void {
  if (process.env.VELLUM_DEV === "1") {
    return;
  }
  if (_instance) {
    return;
  }
  _instance = new UsageTelemetryReporter();
  _instance.start();
  log.info("Usage telemetry reporter started");
}

/**
 * Stop the singleton usage telemetry reporter (final flush + timer teardown)
 * and clear it. No-op when the reporter was never started (e.g. dev mode).
 */
export async function stopUsageTelemetryReporter(): Promise<void> {
  if (!_instance) {
    return;
  }
  try {
    await _instance.stop();
  } finally {
    _instance = null;
  }
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

export class UsageTelemetryReporter {
  private initialFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeFlush: Promise<void> | null = null;
  private readonly sources: readonly TelemetryEventSource[];
  private readonly checkpoints: FlushCheckpointStore;

  constructor(
    sources: readonly TelemetryEventSource[] = ALL_TELEMETRY_EVENT_SOURCES,
    checkpoints: FlushCheckpointStore = telemetryDbFlushCheckpointStore,
  ) {
    this.sources = sources;
    this.checkpoints = checkpoints;
    // `tool_invocations` is an always-on audit table that predates this
    // reporter shipping its rows: an absent watermark means no flush (opted
    // in or out) has ever advanced it, so rows recorded before this build —
    // including any opted-out period under older builds that gated the
    // reporter on the usage-data opt-out — would otherwise ship retroactively.
    // Initialize an absent watermark to "now" at construction. Construction
    // happens during daemon startup before any tool runs, so no legitimate
    // row falls behind the watermark — initializing at first FLUSH instead
    // would drop tools used during the 30s+ flush delay. The checkpoint is
    // persisted immediately so a crash before the first flush can't leave it
    // absent and re-initialize later. An EXISTING watermark is never touched:
    // opted-out sessions keep it advancing via the opt-out flush branch, and
    // overwriting it here would drop a legitimate unshipped backlog.
    // `skill_loaded` needs no init: recording is gated on share_analytics
    // consent, so opt-out rows never exist and its standard 0 default is safe.
    //
    // Best-effort: DB init failures are tolerated at daemon startup (degraded
    // mode), so this must never throw out of the constructor — matching
    // flush(), which treats DB errors as non-fatal.
    if (this.sources.some((s) => s.id === TOOL_EXECUTED_SOURCE_ID)) {
      try {
        const key = watermarkKeysForSource(TOOL_EXECUTED_SOURCE_ID).at;
        if (this.checkpoints.get(key) == null) {
          this.checkpoints.set(key, String(Date.now()));
        }
      } catch (err) {
        log.warn(
          { err },
          "tool_executed watermark init failed at construction — non-fatal; a later construction with a working DB re-runs the absent-checkpoint init",
        );
      }
    }
  }

  start(): void {
    // Delay the first flush to allow the credential infrastructure (CES
    // handshake) to complete. Without this delay, VellumPlatformClient.create()
    // returns null because the credential backend hasn't resolved yet, causing
    // the initial flush to be skipped (we send authenticated-only); the
    // delay lets credentials resolve so the first flush can actually ship.
    this.initialFlushTimer = setTimeout(() => {
      this.initialFlushTimer = null;
      this.flush().catch((err) => {
        log.warn({ err }, "Initial usage telemetry flush failed");
      });
    }, INITIAL_FLUSH_DELAY_MS);
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        log.warn({ err }, "Scheduled usage telemetry flush failed");
      });
    }, REPORT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.initialFlushTimer) {
      clearTimeout(this.initialFlushTimer);
      this.initialFlushTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeFlush) {
      await this.activeFlush;
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.activeFlush) {
      return; // overlap guard
    }
    this.activeFlush = this._doFlush();
    try {
      await this.activeFlush;
    } finally {
      this.activeFlush = null;
    }
  }

  private async _doFlush(batchCount = 0): Promise<void> {
    try {
      if (batchCount >= MAX_CONSECUTIVE_BATCHES) {
        return;
      }

      // Skip when platform features are disabled (VELLUM_DISABLE_PLATFORM in
      // local mode; the flag is ignored when IS_PLATFORM is set, matching
      // VellumPlatformClient.create()). Watermarks are NOT advanced here: this
      // is a deployment/local-mode toggle, not a privacy opt-out, so the unsent
      // backlog ships once the flag is cleared.
      if (!arePlatformFeaturesEnabled()) {
        return;
      }

      // Skip when the flush-checkpoint store (telemetry DB) is unreachable.
      // An unreadable watermark must not be mistaken for cursor 0 — that
      // would requery and re-ship history from the beginning. Nothing is
      // advanced or sent; the cycle retries once the store is back.
      if (!this.checkpoints.isAvailable()) {
        log.warn(
          "Telemetry flush: flush-checkpoint store unavailable — skipping, will retry next cycle",
        );
        return;
      }

      // Respect opt-out: if the platform owner has not granted
      // `share_analytics` consent, skip the flush and advance watermarks so
      // events recorded during the opt-out window are never sent
      // retroactively. The daemon runs the reporter even when opted out
      // specifically so this branch keeps executing — every cycle plus the
      // final flush in stop() — which is what lets a later opt-in (runtime or
      // via restart) resume from a watermark that already covers the opt-out
      // window. One caveat: a RUNTIME false→true flip can still ship up to one
      // flush interval (≤5 min) of pre-toggle rows recorded since the last
      // opted-out flush;
      // the restart path is fully covered by the final flush in stop(). The
      // caveat applies to the always-on tables without a write-time opt-out
      // gate (llm_usage, turn events) and to tool_invocations rows recorded
      // under builds predating the audit listener's write-time gate — new
      // opted-out tool_invocations rows persist NULL telemetry columns and
      // are unreportable by construction regardless of watermark timing.
      if (!getCachedShareAnalytics()) {
        // Advance the timestamp watermarks and pin the ID watermarks to a
        // sentinel that sorts above any real UUID. The sentinel (rather than
        // "") keeps the compound-cursor branch active — a falsy ID would
        // downgrade the query to a timestamp-only `gt(createdAt, watermark)`
        // — while making its same-millisecond arm unsatisfiable, so a row
        // written in the same millisecond as this flush's Date.now() can
        // never ship after a later opt-in. The next opted-in flush that
        // ships events overwrites the sentinel with a real row ID.
        const now = String(Date.now());
        for (const source of this.sources) {
          const keys = watermarkKeysForSource(source.id);
          this.checkpoints.set(keys.at, now);
          this.checkpoints.set(keys.id, OPT_OUT_WATERMARK_ID_SENTINEL);
        }
        return;
      }

      // Read each source's watermark (compound cursor: createdAt + id) and
      // collect its reportable batch. Absent checkpoints default to cursor 0
      // — safe for the consent-gated tables (opted-out rows never exist) and
      // for tool_executed, whose absent watermark was initialized at
      // construction (see the constructor).
      const batches: Array<{
        source: TelemetryEventSource;
        batch: TelemetryEventSourceBatch;
      }> = this.sources.map((source) => {
        const keys = watermarkKeysForSource(source.id);
        const afterCreatedAt = Number(this.checkpoints.get(keys.at) ?? "0");
        const afterId = this.checkpoints.get(keys.id) ?? undefined;
        return {
          source,
          batch: source.collect(afterCreatedAt, afterId, BATCH_SIZE),
        };
      });

      if (batches.every(({ batch }) => batch.events.length === 0)) {
        return;
      }

      // Resolve auth context. We send authenticated-only: if no platform
      // credentials are available yet, skip without advancing watermarks so the
      // backlog ships on a later cycle once credentials resolve.
      const client = await VellumPlatformClient.create();
      if (!client) {
        log.debug(
          {
            pendingEventCount: batches.reduce(
              (total, { batch }) => total + batch.events.length,
              0,
            ),
          },
          "Telemetry flush: no platform credentials — skipping, will retry next cycle",
        );
        return;
      }
      log.debug(
        {
          counts: Object.fromEntries(
            batches.map(({ source, batch }) => [
              source.id,
              batch.events.length,
            ]),
          ),
        },
        "Telemetry flush: resolved auth context",
      );

      // Build payload — sources in construction order, each source's events
      // in cursor order.
      const typedEvents = batches.flatMap(({ batch }) => batch.events);

      const organizationId = getPlatformOrganizationId() || undefined;
      const userId = getPlatformUserId() || undefined;
      const payload = {
        device_id: getDeviceId(),
        assistant_version: APP_VERSION,
        ...(organizationId ? { organization_id: organizationId } : {}),
        ...(userId ? { user_id: userId } : {}),
        events: typedEvents,
      };

      // Send
      const fetchInit: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      };

      const resp = await client.fetch(TELEMETRY_PATH, fetchInit);

      if (!resp.ok) {
        const body = await resp.text();
        log.warn(
          { status: resp.status, body },
          "Usage telemetry POST failed — will retry next cycle",
        );
        return;
      }
      await resp.text(); // consume body to release connection

      // Advance each source's watermark to its last reported row.
      for (const { source, batch } of batches) {
        if (batch.lastCursor) {
          const keys = watermarkKeysForSource(source.id);
          this.checkpoints.set(keys.at, String(batch.lastCursor.createdAt));
          this.checkpoints.set(keys.id, batch.lastCursor.id);
        }
      }

      // If any source produced a full batch, there may be more — recurse.
      if (batches.some(({ batch }) => batch.fullBatch)) {
        await this._doFlush(batchCount + 1);
      }
    } catch (err) {
      log.warn({ err }, "Usage telemetry flush error — non-fatal, will retry");
    }
  }
}
