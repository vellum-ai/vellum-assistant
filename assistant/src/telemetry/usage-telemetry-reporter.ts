/**
 * Usage telemetry reporter.
 *
 * Periodically flushes LLM usage events and turn events (user messages) from
 * the local SQLite database and POSTs them to the platform telemetry endpoint.
 *
 * Two auth modes:
 * - Authenticated: Api-Key header via managed proxy context
 * - Anonymous: X-Telemetry-Token static token from env
 */

import {
  getPlatformOrganizationId,
  getPlatformUserId,
  getTelemetryAppToken,
  getTelemetryPlatformUrl,
} from "../config/env.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../memory/checkpoints.js";
import { queryUnreportedLifecycleEvents } from "../memory/lifecycle-events-store.js";
import { queryUnreportedUsageEvents } from "../memory/llm-usage-store.js";
import { queryUnreportedTurnEvents } from "../memory/turn-events-store.js";
import { resolveManagedProxyContext } from "../providers/managed-proxy/context.js";
import { getExternalAssistantId } from "../runtime/auth/external-assistant-id.js";
import { getDeviceId } from "../util/device-id.js";
import { getLogger } from "../util/logger.js";
import type { TelemetryEvent } from "./types.js";

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
const REPORT_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 500;
const MAX_CONSECUTIVE_BATCHES = 10;
const TELEMETRY_PATH = "/v1/telemetry/ingest/";

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

export class UsageTelemetryReporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeFlush: Promise<void> | null = null;

  start(): void {
    this.flush().catch((err) => {
      log.warn({ err }, "Initial usage telemetry flush failed");
    });
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        log.warn({ err }, "Scheduled usage telemetry flush failed");
      });
    }, REPORT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
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

      if (
        events.length === 0 &&
        turnEvents.length === 0 &&
        lifecycleEvents.length === 0
      )
        return;

      // Resolve auth context — skip flush when neither auth mode is viable
      const proxyCtx = await resolveManagedProxyContext();
      if (!proxyCtx.enabled && !getTelemetryAppToken()) {
        return;
      }

      let url: string;
      let authHeaders: Record<string, string>;

      if (proxyCtx.enabled) {
        url = `${proxyCtx.platformBaseUrl}${TELEMETRY_PATH}`;
        authHeaders = { Authorization: `Api-Key ${proxyCtx.assistantApiKey}` };
      } else {
        url = `${getTelemetryPlatformUrl()}${TELEMETRY_PATH}`;
        authHeaders = { "X-Telemetry-Token": getTelemetryAppToken() };
      }

      // Build payload
      const typedEvents: TelemetryEvent[] = [
        ...events.map(
          (e): TelemetryEvent => ({
            type: "llm_usage",
            daemon_event_id: e.id,
            provider: e.provider,
            model: e.model,
            input_tokens: e.inputTokens,
            output_tokens: e.outputTokens,
            cache_creation_input_tokens: e.cacheCreationInputTokens ?? null,
            cache_read_input_tokens: e.cacheReadInputTokens ?? null,
            actor: e.actor,
            recorded_at: e.createdAt,
          }),
        ),
        ...turnEvents.map(
          (e): TelemetryEvent => ({
            type: "turn",
            daemon_event_id: e.id,
            recorded_at: e.createdAt,
          }),
        ),
        ...lifecycleEvents.map(
          (e): TelemetryEvent => ({
            type: "lifecycle",
            daemon_event_id: e.id,
            event_name: e.eventName,
            recorded_at: e.createdAt,
          }),
        ),
      ];

      const assistantId = getExternalAssistantId() ?? "self";
      const organizationId = getPlatformOrganizationId() || undefined;
      const userId = getPlatformUserId() || undefined;
      const payload = {
        installation_id: getDeviceId(),
        assistant_id: assistantId,
        ...(organizationId ? { organization_id: organizationId } : {}),
        ...(userId ? { user_id: userId } : {}),
        events: typedEvents,
      };

      // Send
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        await resp.text(); // consume body to release connection
        log.warn(
          { status: resp.status, url },
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

      // If we got a full batch of any type, there may be more — recurse
      if (
        events.length === BATCH_SIZE ||
        turnEvents.length === BATCH_SIZE ||
        lifecycleEvents.length === BATCH_SIZE
      ) {
        await this._doFlush(batchCount + 1);
      }
    } catch (err) {
      log.warn({ err }, "Usage telemetry flush error — non-fatal, will retry");
    }
  }
}
