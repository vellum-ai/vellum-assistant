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
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../memory/checkpoints.js";
import { queryUnreportedLifecycleEvents } from "../memory/lifecycle-events-store.js";
import { queryUnreportedUsageEvents } from "../memory/llm-usage-store.js";
import { queryUnreportedTurnEvents } from "../memory/turn-events-store.js";
import { VellumPlatformClient } from "../platform/client.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getExternalAssistantId } from "../runtime/auth/external-assistant-id.js";
import { getDeviceId } from "../util/device-id.js";
import { getLogger } from "../util/logger.js";
import { APP_VERSION } from "../version.js";
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

      // Respect runtime opt-out: if the user has disabled usage data collection,
      // skip the flush and advance watermarks so events recorded during the
      // opt-out window are never sent retroactively.
      if (!getConfig().collectUsageData) {
        // Advance only the timestamp watermarks. Leave the ID watermarks
        // untouched so the compound-cursor branch stays active — setting them
        // to "" would make the truthy check fail, falling back to a
        // timestamp-only `gt(createdAt, watermark)` query that silently drops
        // events created in the same millisecond as the opt-out watermark.
        const now = String(Date.now());
        setMemoryCheckpoint(CHECKPOINT_KEY_WATERMARK, now);
        setMemoryCheckpoint(CHECKPOINT_KEY_TURN_WATERMARK, now);
        setMemoryCheckpoint(CHECKPOINT_KEY_LIFECYCLE_WATERMARK, now);
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

      // Resolve auth context — authenticated path uses client, anonymous path
      // sends unauthenticated (telemetry endpoints are public).
      const client = await VellumPlatformClient.create();
      log.debug(
        {
          authenticated: !!client,
          usageCount: events.length,
          turnCount: turnEvents.length,
          lifecycleCount: lifecycleEvents.length,
        },
        "Telemetry flush: resolved auth context",
      );

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

      const assistantId =
        getExternalAssistantId() ?? DAEMON_INTERNAL_ASSISTANT_ID;
      const organizationId = getPlatformOrganizationId() || undefined;
      const userId = getPlatformUserId() || undefined;
      const payload = {
        device_id: getDeviceId(),
        assistant_id: assistantId,
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
