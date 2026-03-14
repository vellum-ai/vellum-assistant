/**
 * Usage telemetry reporter.
 *
 * Periodically flushes LLM usage events from the local SQLite
 * `llm_usage_events` table and POSTs them to the platform telemetry endpoint.
 *
 * Two auth modes:
 * - Authenticated: Api-Key header via managed proxy context
 * - Anonymous: X-Telemetry-Token static token from env
 */

import { v4 as uuid } from "uuid";

import {
  getTelemetryAppToken,
  getTelemetryPlatformUrl,
} from "../config/env.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../memory/checkpoints.js";
import { queryUnreportedUsageEvents } from "../memory/llm-usage-store.js";
import { resolveManagedProxyContext } from "../providers/managed-proxy/context.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("usage-telemetry");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECKPOINT_KEY_WATERMARK = "telemetry:usage:last_reported_at";
const CHECKPOINT_KEY_INSTALL_ID = "telemetry:installation_id";
const REPORT_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 500;
const MAX_CONSECUTIVE_BATCHES = 10;
const TELEMETRY_PATH = "/v1/assistants/self-hosted-local/telemetry/usage/";

// ---------------------------------------------------------------------------
// Installation ID
// ---------------------------------------------------------------------------

function getOrCreateInstallationId(): string {
  const existing = getMemoryCheckpoint(CHECKPOINT_KEY_INSTALL_ID);
  if (existing) return existing;

  const id = uuid();
  setMemoryCheckpoint(CHECKPOINT_KEY_INSTALL_ID, id);
  return id;
}

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

      // Read watermark
      const watermark = Number(
        getMemoryCheckpoint(CHECKPOINT_KEY_WATERMARK) ?? "0",
      );

      // Query unreported events
      const events = queryUnreportedUsageEvents(watermark, BATCH_SIZE);
      if (events.length === 0) return;

      // Resolve auth context
      const proxyCtx = await resolveManagedProxyContext();

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
      const payload = {
        installation_id: getOrCreateInstallationId(),
        events: events.map((e) => ({
          daemon_event_id: e.id,
          provider: e.provider,
          model: e.model,
          input_tokens: e.inputTokens,
          output_tokens: e.outputTokens,
          cache_creation_input_tokens: e.cacheCreationInputTokens ?? null,
          cache_read_input_tokens: e.cacheReadInputTokens ?? null,
          actor: e.actor,
          recorded_at: e.createdAt,
        })),
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
        log.warn(
          { status: resp.status, url },
          "Usage telemetry POST failed — will retry next cycle",
        );
        return;
      }

      // Advance watermark
      setMemoryCheckpoint(
        CHECKPOINT_KEY_WATERMARK,
        String(events[events.length - 1].createdAt),
      );

      // If we got a full batch, there may be more events — recurse
      if (events.length === BATCH_SIZE) {
        await this._doFlush(batchCount + 1);
      }
    } catch (err) {
      log.warn({ err }, "Usage telemetry flush error — non-fatal, will retry");
    }
  }
}
