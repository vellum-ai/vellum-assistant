/**
 * Usage telemetry reporter.
 *
 * Periodically flushes LLM usage events and turn events (user messages) from
 * the local SQLite database and POSTs them to the platform telemetry endpoint.
 *
 * Authenticated-only: events are sent via the managed proxy context
 * (Api-Key header). When no platform credentials are available, or when
 * platform features are disabled (VELLUM_DISABLE_PLATFORM in local mode), the
 * flush is skipped and retried next cycle.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getPlatformOrganizationId, getPlatformUserId } from "../config/env.js";
import { getConfig } from "../config/loader.js";
import { queryUnreportedOnboardingEvents } from "../onboarding/onboarding-events-store.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../persistence/checkpoints.js";
import { queryUnreportedLifecycleEvents } from "../persistence/lifecycle-events-store.js";
import { queryUnreportedUsageEvents } from "../persistence/llm-usage-store.js";
import { VellumPlatformClient } from "../platform/client.js";
import {
  getCachedShareAnalytics,
  getCachedShareDiagnostics,
  getCachedShareDiagnosticsVersion,
} from "../platform/consent-cache.js";
import { arePlatformFeaturesEnabled } from "../platform/feature-gate.js";
import { queryUnreportedAuthFallbackEvents } from "../security/auth-fallback-events-store.js";
import type { UsageAttributionProfileSource } from "../usage/types.js";
import { getDeviceId } from "../util/device-id.js";
import { getLogger } from "../util/logger.js";
import { APP_VERSION } from "../version.js";
import {
  type ActivationStepName,
  buildActivationDaemonEventId,
} from "./activation-funnel.js";
import { queryUnreportedConfigSettingEvents } from "./config-setting-events-store.js";
import { queryUnreportedSkillLoadedEvents } from "./skill-loaded-events-store.js";
import { queryUnreportedToolExecutedEvents } from "./tool-executed-events-store.js";
import { isDiagnosticsConsentVersionEligible } from "./trace-collection-policy.js";
import { queryUnreportedTurnEvents } from "./turn-events-store.js";
import { assembleBoundedTurnTrace, isTurnSettled } from "./turn-trace-store.js";
import type { TelemetryEvent, TurnTelemetryClientInfo } from "./types.js";
import { queryUnreportedWatchdogEvents } from "./watchdog-events-store.js";

const log = getLogger("usage-telemetry");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECKPOINT_KEY_WATERMARK = "telemetry:usage:last_reported_at";
const CHECKPOINT_KEY_WATERMARK_ID = "telemetry:usage:last_reported_id";
const CHECKPOINT_KEY_TURN_WATERMARK = "telemetry:turns:last_reported_at";
const CHECKPOINT_KEY_TURN_WATERMARK_ID = "telemetry:turns:last_reported_id";
const CHECKPOINT_KEY_LIFECYCLE_WATERMARK =
  "telemetry:lifecycle:last_reported_at";
const CHECKPOINT_KEY_LIFECYCLE_WATERMARK_ID =
  "telemetry:lifecycle:last_reported_id";
const CHECKPOINT_KEY_ONBOARDING_WATERMARK =
  "telemetry:onboarding:last_reported_at";
const CHECKPOINT_KEY_ONBOARDING_WATERMARK_ID =
  "telemetry:onboarding:last_reported_id";
const CHECKPOINT_KEY_AUTH_FALLBACK_WATERMARK =
  "telemetry:auth_fallback:last_reported_at";
const CHECKPOINT_KEY_AUTH_FALLBACK_WATERMARK_ID =
  "telemetry:auth_fallback:last_reported_id";
const CHECKPOINT_KEY_TOOL_EXECUTED_WATERMARK =
  "telemetry:tool_executed:last_reported_at";
const CHECKPOINT_KEY_TOOL_EXECUTED_WATERMARK_ID =
  "telemetry:tool_executed:last_reported_id";
const CHECKPOINT_KEY_SKILL_LOADED_WATERMARK =
  "telemetry:skill_loaded:last_reported_at";
const CHECKPOINT_KEY_SKILL_LOADED_WATERMARK_ID =
  "telemetry:skill_loaded:last_reported_id";
const CHECKPOINT_KEY_WATCHDOG_WATERMARK = "telemetry:watchdog:last_reported_at";
const CHECKPOINT_KEY_WATCHDOG_WATERMARK_ID =
  "telemetry:watchdog:last_reported_id";
const CHECKPOINT_KEY_CONFIG_SETTING_WATERMARK =
  "telemetry:config_setting:last_reported_at";
const CHECKPOINT_KEY_CONFIG_SETTING_WATERMARK_ID =
  "telemetry:config_setting:last_reported_id";
// Written into the `*_id` watermark checkpoints by the opt-out flush branch.
// Sorts lexicographically above every real row ID (all event stores generate
// lowercase v4 UUIDs), so the compound cursor's same-millisecond arm
// (`createdAt == watermark AND id > afterId`) can never match an opt-out row.
const OPT_OUT_WATERMARK_ID_SENTINEL = "ffffffff-ffff-ffff-ffff-ffffffffffff";
// (timestamp, id) checkpoint-key pairs for every event type's compound
// cursor — keep in sync when adding an event type.
const WATERMARK_KEY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [CHECKPOINT_KEY_WATERMARK, CHECKPOINT_KEY_WATERMARK_ID],
  [CHECKPOINT_KEY_TURN_WATERMARK, CHECKPOINT_KEY_TURN_WATERMARK_ID],
  [CHECKPOINT_KEY_LIFECYCLE_WATERMARK, CHECKPOINT_KEY_LIFECYCLE_WATERMARK_ID],
  [CHECKPOINT_KEY_ONBOARDING_WATERMARK, CHECKPOINT_KEY_ONBOARDING_WATERMARK_ID],
  [
    CHECKPOINT_KEY_AUTH_FALLBACK_WATERMARK,
    CHECKPOINT_KEY_AUTH_FALLBACK_WATERMARK_ID,
  ],
  [
    CHECKPOINT_KEY_TOOL_EXECUTED_WATERMARK,
    CHECKPOINT_KEY_TOOL_EXECUTED_WATERMARK_ID,
  ],
  [
    CHECKPOINT_KEY_SKILL_LOADED_WATERMARK,
    CHECKPOINT_KEY_SKILL_LOADED_WATERMARK_ID,
  ],
  [CHECKPOINT_KEY_WATCHDOG_WATERMARK, CHECKPOINT_KEY_WATCHDOG_WATERMARK_ID],
  [
    CHECKPOINT_KEY_CONFIG_SETTING_WATERMARK,
    CHECKPOINT_KEY_CONFIG_SETTING_WATERMARK_ID,
  ],
];
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
  if (process.env.VELLUM_DEV === "1") return;
  if (_instance) return;
  _instance = new UsageTelemetryReporter();
  _instance.start();
  log.info("Usage telemetry reporter started");
}

/**
 * Stop the singleton usage telemetry reporter (final flush + timer teardown)
 * and clear it. No-op when the reporter was never started (e.g. dev mode).
 */
export async function stopUsageTelemetryReporter(): Promise<void> {
  if (!_instance) return;
  try {
    await _instance.stop();
  } finally {
    _instance = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a stored `watchdog_events.detail` JSON text column into the object the
 * platform expects. Returns null for a null column or an unparseable/corrupted
 * blob (mirroring the turn `client` metadata parse: a bad blob emits null
 * rather than failing the batch). A non-object (e.g. a bare number or string)
 * also resolves to null, since the platform serializer treats `detail` as a
 * JSON object bag.
 */
function parseWatchdogDetail(
  raw: string | null,
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    log.warn(
      { rawDetail: raw.slice(0, 200) },
      "Telemetry watchdog: failed to parse detail; emitting null",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

export class UsageTelemetryReporter {
  private initialFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeFlush: Promise<void> | null = null;

  constructor() {
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
    try {
      if (getMemoryCheckpoint(CHECKPOINT_KEY_TOOL_EXECUTED_WATERMARK) == null) {
        setMemoryCheckpoint(
          CHECKPOINT_KEY_TOOL_EXECUTED_WATERMARK,
          String(Date.now()),
        );
      }
    } catch (err) {
      log.warn(
        { err },
        "tool_executed watermark init failed at construction — non-fatal; a later construction with a working DB re-runs the absent-checkpoint init",
      );
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
    if (this.activeFlush) return; // overlap guard
    this.activeFlush = this._doFlush();
    try {
      await this.activeFlush;
    } finally {
      this.activeFlush = null;
    }
  }

  private async _doFlush(batchCount = 0): Promise<void> {
    try {
      if (batchCount >= MAX_CONSECUTIVE_BATCHES) return;

      // Skip when platform features are disabled (VELLUM_DISABLE_PLATFORM in
      // local mode; the flag is ignored when IS_PLATFORM is set, matching
      // VellumPlatformClient.create()). Watermarks are NOT advanced here: this
      // is a deployment/local-mode toggle, not a privacy opt-out, so the unsent
      // backlog ships once the flag is cleared.
      if (!arePlatformFeaturesEnabled()) {
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
        for (const [timestampKey, idKey] of WATERMARK_KEY_PAIRS) {
          setMemoryCheckpoint(timestampKey, now);
          setMemoryCheckpoint(idKey, OPT_OUT_WATERMARK_ID_SENTINEL);
        }
        return;
      }

      // Read usage watermark (compound cursor: createdAt + id)
      const watermark = Number(
        getMemoryCheckpoint(CHECKPOINT_KEY_WATERMARK) ?? "0",
      );
      const watermarkId =
        getMemoryCheckpoint(CHECKPOINT_KEY_WATERMARK_ID) ?? undefined;

      // Read turn watermark (compound cursor: createdAt + id)
      const turnWatermark = Number(
        getMemoryCheckpoint(CHECKPOINT_KEY_TURN_WATERMARK) ?? "0",
      );
      const turnWatermarkId =
        getMemoryCheckpoint(CHECKPOINT_KEY_TURN_WATERMARK_ID) ?? undefined;

      // Read lifecycle watermark (compound cursor: createdAt + id)
      const lifecycleWatermark = Number(
        getMemoryCheckpoint(CHECKPOINT_KEY_LIFECYCLE_WATERMARK) ?? "0",
      );
      const lifecycleWatermarkId =
        getMemoryCheckpoint(CHECKPOINT_KEY_LIFECYCLE_WATERMARK_ID) ?? undefined;

      // Read onboarding watermark (compound cursor: createdAt + id)
      const onboardingWatermark = Number(
        getMemoryCheckpoint(CHECKPOINT_KEY_ONBOARDING_WATERMARK) ?? "0",
      );
      const onboardingWatermarkId =
        getMemoryCheckpoint(CHECKPOINT_KEY_ONBOARDING_WATERMARK_ID) ??
        undefined;

      // Read auth-fallback watermark (compound cursor: createdAt + id)
      const authFallbackWatermark = Number(
        getMemoryCheckpoint(CHECKPOINT_KEY_AUTH_FALLBACK_WATERMARK) ?? "0",
      );
      const authFallbackWatermarkId =
        getMemoryCheckpoint(CHECKPOINT_KEY_AUTH_FALLBACK_WATERMARK_ID) ??
        undefined;

      // Read tool-executed watermark (compound cursor: createdAt + id).
      // An absent checkpoint was initialized to construction time (see the
      // constructor), guarding opt-out windows; the 0 fallback here is a
      // defensive default matching the other event types. Legacy rows are
      // excluded at the query level (see queryUnreportedToolExecutedEvents).
      const toolExecutedWatermark = Number(
        getMemoryCheckpoint(CHECKPOINT_KEY_TOOL_EXECUTED_WATERMARK) ?? "0",
      );
      const toolExecutedWatermarkId =
        getMemoryCheckpoint(CHECKPOINT_KEY_TOOL_EXECUTED_WATERMARK_ID) ??
        undefined;

      // Read skill-loaded watermark (compound cursor: createdAt + id).
      // Writes are gated on share_analytics consent, so opted-out rows
      // cannot exist and the standard 0 default is safe.
      const skillLoadedWatermark = Number(
        getMemoryCheckpoint(CHECKPOINT_KEY_SKILL_LOADED_WATERMARK) ?? "0",
      );
      const skillLoadedWatermarkId =
        getMemoryCheckpoint(CHECKPOINT_KEY_SKILL_LOADED_WATERMARK_ID) ??
        undefined;

      // Read watchdog watermark (compound cursor: createdAt + id).
      // Writes are gated on share_analytics consent, so opted-out rows
      // cannot exist and the standard 0 default is safe.
      const watchdogWatermark = Number(
        getMemoryCheckpoint(CHECKPOINT_KEY_WATCHDOG_WATERMARK) ?? "0",
      );
      const watchdogWatermarkId =
        getMemoryCheckpoint(CHECKPOINT_KEY_WATCHDOG_WATERMARK_ID) ?? undefined;

      // Read config-setting watermark (compound cursor: createdAt + id).
      // Writes are gated on share_analytics consent, so opted-out rows
      // cannot exist and the standard 0 default is safe.
      const configSettingWatermark = Number(
        getMemoryCheckpoint(CHECKPOINT_KEY_CONFIG_SETTING_WATERMARK) ?? "0",
      );
      const configSettingWatermarkId =
        getMemoryCheckpoint(CHECKPOINT_KEY_CONFIG_SETTING_WATERMARK_ID) ??
        undefined;

      // Query unreported events
      const events = queryUnreportedUsageEvents(
        watermark,
        watermarkId,
        BATCH_SIZE,
      );
      const turnEvents = queryUnreportedTurnEvents(
        turnWatermark,
        turnWatermarkId,
        BATCH_SIZE,
      );
      const lifecycleEvents = queryUnreportedLifecycleEvents(
        lifecycleWatermark,
        lifecycleWatermarkId,
        BATCH_SIZE,
      );
      const onboardingEvents = queryUnreportedOnboardingEvents(
        onboardingWatermark,
        onboardingWatermarkId,
        BATCH_SIZE,
      );
      const authFallbackEvents = queryUnreportedAuthFallbackEvents(
        authFallbackWatermark,
        authFallbackWatermarkId,
        BATCH_SIZE,
      );
      const toolExecutedEvents = queryUnreportedToolExecutedEvents(
        toolExecutedWatermark,
        toolExecutedWatermarkId,
        BATCH_SIZE,
      );
      const skillLoadedEvents = queryUnreportedSkillLoadedEvents(
        skillLoadedWatermark,
        skillLoadedWatermarkId,
        BATCH_SIZE,
      );
      const watchdogEvents = queryUnreportedWatchdogEvents(
        watchdogWatermark,
        watchdogWatermarkId,
        BATCH_SIZE,
      );
      const configSettingEvents = queryUnreportedConfigSettingEvents(
        configSettingWatermark,
        configSettingWatermarkId,
        BATCH_SIZE,
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
      // never leave the device. Three parts, fail-closed (all must be true):
      //   1. the `trace-collection` LaunchDarkly flag (delivered via the
      //      assistant-tagged flag sync, already evaluated server-side for this
      //      assistant's owner),
      //   2. the owner's cached `share_diagnostics` consent, and
      //   3. the owner's cached `share_diagnostics_accepted_version` being at or
      //      past the disclosing version — the platform applies the identical
      //      check, so an old consent never yields a trace here or there.
      const traceEligible =
        isAssistantFeatureFlagEnabled("trace-collection", getConfig()) &&
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

      if (
        events.length === 0 &&
        reportableTurnEvents.length === 0 &&
        lifecycleEvents.length === 0 &&
        onboardingEvents.length === 0 &&
        authFallbackEvents.length === 0 &&
        toolExecutedEvents.length === 0 &&
        skillLoadedEvents.length === 0 &&
        watchdogEvents.length === 0 &&
        configSettingEvents.length === 0
      ) {
        return;
      }

      // Resolve auth context. We send authenticated-only: if no platform
      // credentials are available yet, skip without advancing watermarks so the
      // backlog ships on a later cycle once credentials resolve.
      const client = await VellumPlatformClient.create();
      if (!client) {
        log.debug(
          { pendingEventCount: events.length + turnEvents.length },
          "Telemetry flush: no platform credentials — skipping, will retry next cycle",
        );
        return;
      }
      log.debug(
        {
          usageCount: events.length,
          turnCount: reportableTurnEvents.length,
          lifecycleCount: lifecycleEvents.length,
          onboardingCount: onboardingEvents.length,
          authFallbackCount: authFallbackEvents.length,
          toolExecutedCount: toolExecutedEvents.length,
          skillLoadedCount: skillLoadedEvents.length,
          watchdogCount: watchdogEvents.length,
          configSettingCount: configSettingEvents.length,
        },
        "Telemetry flush: resolved auth context",
      );

      // Build payload
      const typedEvents: TelemetryEvent[] = [
        ...events.map(
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
        ),
        ...reportableTurnEvents.map((e): TelemetryEvent => {
          // Per-turn trace collection gate. `traceEligible` (computed above)
          // requires the `trace-collection` flag AND the owner's cached
          // `share_diagnostics` consent AND an eligible accepted consent
          // version. Fail-closed: when any is off the trace is omitted and the
          // trace-free turn row flushes as before. The
          // `share_analytics` gate above already passed, so this is an
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
              if (
                parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)
              ) {
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
            // over the envelope). Same upload-time attribution risk
            // for turn events as before this PR — lifecycle, onboarding
            // and turn events all still rely on the envelope; only
            // llm_usage is record-time accurate in this PR.
            assistant_version: APP_VERSION,
          };
        }),
        ...lifecycleEvents.map(
          (e): TelemetryEvent => ({
            type: "lifecycle",
            daemon_event_id: e.id,
            event_name: e.eventName,
            recorded_at: e.createdAt,
            // Lifecycle events fall back to the envelope `assistant_version`
            // — same upload-time attribution risk as before this PR. Adding
            // the record-time column to `lifecycle_events` (#18112) is a
            // separate follow-up that mirrors what this PR does for
            // `llm_usage_events`.
            assistant_version: APP_VERSION,
          }),
        ),
        ...onboardingEvents.map(
          (e): TelemetryEvent => ({
            type: "onboarding",
            // Wire-only override for activation rows: a deterministic id keyed
            // on funnel_version/session/step lets dbt collapse a moment that
            // fires more than once. Key on the ROW's stored `funnelVersion`
            // (not the binary's current constant) so rows recorded under an
            // older version — flushed offline or after an upgrade — keep a
            // stable id and still collapse with already-ingested rows. The
            // SQLite watermark cursor still uses `e.id`/`e.createdAt`, so this
            // override is checkpoint-safe.
            daemon_event_id:
              e.sessionId && e.stepName && e.funnelVersion
                ? buildActivationDaemonEventId(
                    e.sessionId,
                    e.stepName as ActivationStepName,
                    e.funnelVersion,
                  )
                : e.id,
            recorded_at: e.createdAt,
            screen: e.screen,
            ...(e.toolsJson ? { tools: JSON.parse(e.toolsJson) } : {}),
            ...(e.tasksJson ? { tasks: JSON.parse(e.tasksJson) } : {}),
            ...(e.tone ? { tone: e.tone } : {}),
            ...(e.googleConnected != null
              ? { google_connected: e.googleConnected }
              : {}),
            ...(e.googleScopesJson
              ? { google_scopes: JSON.parse(e.googleScopesJson) }
              : {}),
            ...(e.abVariant ? { ab_variant: e.abVariant } : {}),
            // Activation funnel fields — only present on activation rows.
            ...(e.sessionId ? { session_id: e.sessionId } : {}),
            ...(e.stepName ? { step_name: e.stepName } : {}),
            ...(e.stepIndex != null ? { step_index: e.stepIndex } : {}),
            ...(e.completedAt ? { completed_at: e.completedAt } : {}),
            ...(e.funnelVersion ? { funnel_version: e.funnelVersion } : {}),
            // Onboarding events fall back to the envelope `assistant_version`,
            // so events recorded under an older build are attributed to the
            // version running at upload time. Adding a record-time column to
            // `onboarding_events` (mirroring `llm_usage_events`) is a known
            // follow-up.
            assistant_version: APP_VERSION,
          }),
        ),
        ...authFallbackEvents.map(
          (e): TelemetryEvent => ({
            type: "auth_fallback",
            daemon_event_id: e.id,
            recorded_at: e.createdAt,
            guard: e.guard,
            path: e.path,
            failure_kind: e.failureKind,
            count: e.count,
            window_start: e.windowStart,
            window_end: e.windowEnd,
            // Aggregated counts forwarded by the gateway carry no record-time
            // binary version; stamp the running binary's `APP_VERSION` so the
            // wire value is concrete rather than an explicit null that would
            // override the envelope under the platform's per-event-wins
            // contract.
            assistant_version: APP_VERSION,
          }),
        ),
        ...toolExecutedEvents.map(
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
        ),
        ...skillLoadedEvents.map(
          (e): TelemetryEvent => ({
            type: "skill_loaded",
            daemon_event_id: e.id,
            recorded_at: e.createdAt,
            skill_name: e.skillName,
            skill_updated_at: e.skillUpdatedAt,
            conversation_id: e.conversationId,
            provider: e.provider,
            model: e.model,
            inference_profile: e.inferenceProfile,
            inference_profile_source:
              e.inferenceProfileSource as UsageAttributionProfileSource | null,
            // `skill_loaded_events` has no record-time version column — same
            // upload-time APP_VERSION stamping as the other non-llm_usage
            // event types.
            assistant_version: APP_VERSION,
          }),
        ),
        ...watchdogEvents.map(
          (e): TelemetryEvent => ({
            type: "watchdog",
            daemon_event_id: e.id,
            recorded_at: e.createdAt,
            check_name: e.checkName,
            value: e.value,
            // `detail` is stored as JSON text; parse defensively so a
            // corrupted blob never fails the batch flush. A parse failure
            // emits null rather than dropping the event.
            detail: parseWatchdogDetail(e.detail),
            // `watchdog_events` has no record-time version column — same
            // upload-time APP_VERSION stamping as the other non-llm_usage
            // event types.
            assistant_version: APP_VERSION,
          }),
        ),
        ...configSettingEvents.map(
          (e): TelemetryEvent => ({
            type: "config_setting",
            daemon_event_id: e.id,
            recorded_at: e.createdAt,
            config_key: e.configKey,
            config_value: e.configValue,
            // `config_setting_events` has no record-time version column —
            // same upload-time APP_VERSION stamping as the other
            // non-llm_usage event types.
            assistant_version: APP_VERSION,
          }),
        ),
      ];

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

      // Advance usage watermark (compound cursor)
      if (events.length > 0) {
        const lastEvent = events[events.length - 1];
        setMemoryCheckpoint(
          CHECKPOINT_KEY_WATERMARK,
          String(lastEvent.createdAt),
        );
        setMemoryCheckpoint(CHECKPOINT_KEY_WATERMARK_ID, lastEvent.id);
      }

      // Advance turn watermark (compound cursor) — only to the last REPORTED
      // turn. Deferred (in-flight) turns sit beyond this cursor and are
      // re-evaluated on a later flush, so the watermark never skips them.
      if (reportableTurnEvents.length > 0) {
        const lastTurn = reportableTurnEvents[reportableTurnEvents.length - 1];
        setMemoryCheckpoint(
          CHECKPOINT_KEY_TURN_WATERMARK,
          String(lastTurn.createdAt),
        );
        setMemoryCheckpoint(CHECKPOINT_KEY_TURN_WATERMARK_ID, lastTurn.id);
      }

      // Advance lifecycle watermark (compound cursor)
      if (lifecycleEvents.length > 0) {
        const lastLifecycle = lifecycleEvents[lifecycleEvents.length - 1];
        setMemoryCheckpoint(
          CHECKPOINT_KEY_LIFECYCLE_WATERMARK,
          String(lastLifecycle.createdAt),
        );
        setMemoryCheckpoint(
          CHECKPOINT_KEY_LIFECYCLE_WATERMARK_ID,
          lastLifecycle.id,
        );
      }

      // Advance onboarding watermark (compound cursor)
      if (onboardingEvents.length > 0) {
        const lastOnboarding = onboardingEvents[onboardingEvents.length - 1];
        setMemoryCheckpoint(
          CHECKPOINT_KEY_ONBOARDING_WATERMARK,
          String(lastOnboarding.createdAt),
        );
        setMemoryCheckpoint(
          CHECKPOINT_KEY_ONBOARDING_WATERMARK_ID,
          lastOnboarding.id,
        );
      }

      // Advance auth-fallback watermark (compound cursor)
      if (authFallbackEvents.length > 0) {
        const lastAuthFallback =
          authFallbackEvents[authFallbackEvents.length - 1];
        setMemoryCheckpoint(
          CHECKPOINT_KEY_AUTH_FALLBACK_WATERMARK,
          String(lastAuthFallback.createdAt),
        );
        setMemoryCheckpoint(
          CHECKPOINT_KEY_AUTH_FALLBACK_WATERMARK_ID,
          lastAuthFallback.id,
        );
      }

      // Advance tool-executed watermark (compound cursor)
      if (toolExecutedEvents.length > 0) {
        const lastToolExecuted =
          toolExecutedEvents[toolExecutedEvents.length - 1];
        setMemoryCheckpoint(
          CHECKPOINT_KEY_TOOL_EXECUTED_WATERMARK,
          String(lastToolExecuted.createdAt),
        );
        setMemoryCheckpoint(
          CHECKPOINT_KEY_TOOL_EXECUTED_WATERMARK_ID,
          lastToolExecuted.id,
        );
      }

      // Advance skill-loaded watermark (compound cursor)
      if (skillLoadedEvents.length > 0) {
        const lastSkillLoaded = skillLoadedEvents[skillLoadedEvents.length - 1];
        setMemoryCheckpoint(
          CHECKPOINT_KEY_SKILL_LOADED_WATERMARK,
          String(lastSkillLoaded.createdAt),
        );
        setMemoryCheckpoint(
          CHECKPOINT_KEY_SKILL_LOADED_WATERMARK_ID,
          lastSkillLoaded.id,
        );
      }

      // Advance watchdog watermark (compound cursor)
      if (watchdogEvents.length > 0) {
        const lastWatchdog = watchdogEvents[watchdogEvents.length - 1];
        setMemoryCheckpoint(
          CHECKPOINT_KEY_WATCHDOG_WATERMARK,
          String(lastWatchdog.createdAt),
        );
        setMemoryCheckpoint(
          CHECKPOINT_KEY_WATCHDOG_WATERMARK_ID,
          lastWatchdog.id,
        );
      }

      // Advance config-setting watermark (compound cursor)
      if (configSettingEvents.length > 0) {
        const lastConfigSetting =
          configSettingEvents[configSettingEvents.length - 1];
        setMemoryCheckpoint(
          CHECKPOINT_KEY_CONFIG_SETTING_WATERMARK,
          String(lastConfigSetting.createdAt),
        );
        setMemoryCheckpoint(
          CHECKPOINT_KEY_CONFIG_SETTING_WATERMARK_ID,
          lastConfigSetting.id,
        );
      }

      // If we got a full batch of any type, there may be more — recurse.
      // Turns use the REPORTED count: when the completeness barrier truncates
      // the batch, the deferred turns must wait for a later flush (by which
      // point they've settled) rather than being re-queried and re-deferred in
      // a tight recursion.
      if (
        events.length === BATCH_SIZE ||
        reportableTurnEvents.length === BATCH_SIZE ||
        lifecycleEvents.length === BATCH_SIZE ||
        onboardingEvents.length === BATCH_SIZE ||
        authFallbackEvents.length === BATCH_SIZE ||
        toolExecutedEvents.length === BATCH_SIZE ||
        skillLoadedEvents.length === BATCH_SIZE ||
        watchdogEvents.length === BATCH_SIZE ||
        configSettingEvents.length === BATCH_SIZE
      ) {
        await this._doFlush(batchCount + 1);
      }
    } catch (err) {
      log.warn({ err }, "Usage telemetry flush error — non-fatal, will retry");
    }
  }
}
