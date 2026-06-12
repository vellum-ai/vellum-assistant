/**
 * Usage telemetry reporter.
 *
 * Periodically flushes LLM usage events and turn events (user messages) from
 * the local SQLite database and POSTs them to the platform telemetry endpoint.
 *
 * Two auth modes:
 * - Authenticated: Api-Key header via managed proxy context
 * - Anonymous: unauthenticated POST (telemetry endpoints are public)
 */

import {
  getPlatformBaseUrl,
  getPlatformOrganizationId,
  getPlatformUserId,
} from "../config/env.js";
import { getConfig } from "../config/loader.js";
import { queryUnreportedAuthFallbackEvents } from "../memory/auth-fallback-events-store.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../memory/checkpoints.js";
import { queryUnreportedLifecycleEvents } from "../memory/lifecycle-events-store.js";
import { queryUnreportedUsageEvents } from "../memory/llm-usage-store.js";
import { queryUnreportedOnboardingEvents } from "../memory/onboarding-events-store.js";
import { queryUnreportedSkillLoadedEvents } from "../memory/skill-loaded-events-store.js";
import { queryUnreportedToolExecutedEvents } from "../memory/tool-executed-events-store.js";
import { queryUnreportedTurnEvents } from "../memory/turn-events-store.js";
import { VellumPlatformClient } from "../platform/client.js";
import type { UsageAttributionProfileSource } from "../usage/types.js";
import { getDeviceId } from "../util/device-id.js";
import { getLogger } from "../util/logger.js";
import { APP_VERSION } from "../version.js";
import {
  type ActivationStepName,
  buildActivationDaemonEventId,
} from "./activation-funnel.js";
import type { TelemetryEvent, TurnTelemetryClientInfo } from "./types.js";

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

export function setUsageTelemetryReporter(
  reporter: UsageTelemetryReporter | null,
): void {
  _instance = reporter;
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
    // reporter on collectUsageData — would otherwise ship retroactively.
    // Initialize an absent watermark to "now" at construction. Construction
    // happens during daemon startup before any tool runs, so no legitimate
    // row falls behind the watermark — initializing at first FLUSH instead
    // would drop tools used during the 30s+ flush delay. The checkpoint is
    // persisted immediately so a crash before the first flush can't leave it
    // absent and re-initialize later. An EXISTING watermark is never touched:
    // opted-out sessions keep it advancing via the opt-out flush branch, and
    // overwriting it here would drop a legitimate unshipped backlog.
    // `skill_loaded` needs no init: recording is gated on collectUsageData,
    // so opt-out rows never exist and its standard 0 default is safe.
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
    // telemetry to fall back to anonymous mode permanently.
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

      // Respect opt-out: if the user has disabled usage data collection, skip
      // the flush and advance watermarks so events recorded during the
      // opt-out window are never sent retroactively. The daemon runs the
      // reporter even when opted out specifically so this branch keeps
      // executing — every cycle plus the final flush in stop() — which is
      // what lets a later opt-in (runtime or via restart) resume from a
      // watermark that already covers the opt-out window. One caveat: a
      // RUNTIME false→true flip can still ship up to one flush interval
      // (≤5 min) of pre-toggle rows recorded since the last opted-out flush;
      // the restart path is fully covered by the final flush in stop(). The
      // caveat applies to the always-on tables without a write-time opt-out
      // gate (llm_usage, turn events) and to tool_invocations rows recorded
      // under builds predating the audit listener's write-time gate — new
      // opted-out tool_invocations rows persist NULL telemetry columns and
      // are unreportable by construction regardless of watermark timing.
      if (!getConfig().collectUsageData) {
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
      // Brand-new table, so the standard 0 default is safe.
      const skillLoadedWatermark = Number(
        getMemoryCheckpoint(CHECKPOINT_KEY_SKILL_LOADED_WATERMARK) ?? "0",
      );
      const skillLoadedWatermarkId =
        getMemoryCheckpoint(CHECKPOINT_KEY_SKILL_LOADED_WATERMARK_ID) ??
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

      if (
        events.length === 0 &&
        turnEvents.length === 0 &&
        lifecycleEvents.length === 0 &&
        onboardingEvents.length === 0 &&
        authFallbackEvents.length === 0 &&
        toolExecutedEvents.length === 0 &&
        skillLoadedEvents.length === 0
      )
        return;

      // Resolve auth context — authenticated path uses client, anonymous path
      // sends unauthenticated (telemetry endpoints are public).
      const client = await VellumPlatformClient.create();
      log.debug(
        {
          authenticated: !!client,
          usageCount: events.length,
          turnCount: turnEvents.length,
          lifecycleCount: lifecycleEvents.length,
          onboardingCount: onboardingEvents.length,
          authFallbackCount: authFallbackEvents.length,
          toolExecutedCount: toolExecutedEvents.length,
          skillLoadedCount: skillLoadedEvents.length,
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
        ...turnEvents.map((e): TelemetryEvent => {
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

      let resp: Response;
      if (client) {
        resp = await client.fetch(TELEMETRY_PATH, fetchInit);
      } else {
        const url = `${getPlatformBaseUrl()}${TELEMETRY_PATH}`;
        resp = await fetch(url, fetchInit);
      }

      if (!resp.ok) {
        const body = await resp.text();
        log.warn(
          { status: resp.status, authenticated: !!client, body },
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

      // Advance turn watermark (compound cursor)
      if (turnEvents.length > 0) {
        const lastTurn = turnEvents[turnEvents.length - 1];
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

      // If we got a full batch of any type, there may be more — recurse
      if (
        events.length === BATCH_SIZE ||
        turnEvents.length === BATCH_SIZE ||
        lifecycleEvents.length === BATCH_SIZE ||
        onboardingEvents.length === BATCH_SIZE ||
        authFallbackEvents.length === BATCH_SIZE ||
        toolExecutedEvents.length === BATCH_SIZE ||
        skillLoadedEvents.length === BATCH_SIZE
      ) {
        await this._doFlush(batchCount + 1);
      }
    } catch (err) {
      log.warn({ err }, "Usage telemetry flush error — non-fatal, will retry");
    }
  }
}
