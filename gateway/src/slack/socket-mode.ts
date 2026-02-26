import { getLogger } from "../logger.js";
import { fetchImpl } from "../fetch.js";
import type { GatewayConfig } from "../config.js";
import { normalizeSlackAppMention, type SlackAppMentionEvent, type NormalizedSlackEvent } from "./normalize.js";

const log = getLogger("slack-socket-mode");

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

export type SlackSocketModeConfig = {
  appToken: string;
  botToken: string;
  gatewayConfig: GatewayConfig;
};

/**
 * Slack Socket Mode WebSocket client.
 *
 * Opens a Socket Mode connection via `apps.connections.open`, maintains
 * a single active WebSocket, auto-reconnects with capped exponential
 * backoff + jitter, ACKs every envelope immediately, deduplicates events
 * by `event_id`, and emits normalized `app_mention` events via callback.
 */
export class SlackSocketModeClient {
  private config: SlackSocketModeConfig;
  private onEvent: (event: NormalizedSlackEvent) => void;
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private dedupMap = new Map<string, number>();
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SlackSocketModeConfig, onEvent: (event: NormalizedSlackEvent) => void) {
    this.config = config;
    this.onEvent = onEvent;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startDedupCleanup();
    await this.connect();
  }

  stop(): void {
    this.running = false;
    this.stopDedupCleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "client shutdown");
      } catch {
        // ignore close errors during shutdown
      }
      this.ws = null;
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return;

    let wsUrl: string;
    try {
      wsUrl = await this.getWebSocketUrl();
    } catch (err) {
      log.error({ err }, "Failed to obtain Socket Mode WebSocket URL");
      this.scheduleReconnect();
      return;
    }

    log.info("Connecting to Slack Socket Mode");

    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.addEventListener("open", () => {
        log.info("Slack Socket Mode connected");
        this.reconnectAttempt = 0;
      });

      ws.addEventListener("message", (messageEvent) => {
        this.handleMessage(messageEvent.data as string);
      });

      ws.addEventListener("close", (closeEvent) => {
        log.info({ code: closeEvent.code, reason: closeEvent.reason }, "Slack Socket Mode disconnected");
        this.ws = null;
        this.scheduleReconnect();
      });

      ws.addEventListener("error", (errorEvent) => {
        log.error({ error: String(errorEvent) }, "Slack Socket Mode WebSocket error");
      });
    } catch (err) {
      log.error({ err }, "Failed to create WebSocket connection");
      this.ws = null;
      this.scheduleReconnect();
    }
  }

  private async getWebSocketUrl(): Promise<string> {
    const resp = await fetchImpl("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!resp.ok) {
      throw new Error(`apps.connections.open HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as { ok: boolean; url?: string; error?: string };
    if (!data.ok || !data.url) {
      throw new Error(`apps.connections.open failed: ${data.error ?? "unknown error"}`);
    }

    return data.url;
  }

  private handleMessage(raw: string): void {
    let envelope: {
      envelope_id?: string;
      type?: string;
      payload?: {
        event_id?: string;
        event?: SlackAppMentionEvent;
      };
      reason?: string;
    };

    try {
      envelope = JSON.parse(raw);
    } catch {
      log.warn("Received non-JSON Socket Mode message");
      return;
    }

    // ACK every envelope immediately
    if (envelope.envelope_id && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    // Handle disconnect type: Slack asks us to reconnect
    if (envelope.type === "disconnect") {
      log.info({ reason: envelope.reason }, "Slack requested disconnect, reconnecting");
      if (this.ws) {
        try {
          this.ws.close(1000, "server requested disconnect");
        } catch {
          // ignore
        }
        this.ws = null;
      }
      // Reconnect immediately (attempt 0 = minimal backoff)
      this.reconnectAttempt = 0;
      this.scheduleReconnect();
      return;
    }

    // Only process events_api envelopes
    if (envelope.type !== "events_api") return;

    const eventPayload = envelope.payload;
    if (!eventPayload?.event || !eventPayload.event_id) return;

    // Only process app_mention events in MVP
    if (eventPayload.event.type !== "app_mention") return;

    // Deduplicate on event_id
    const eventId = eventPayload.event_id;
    if (this.dedupMap.has(eventId)) {
      log.debug({ eventId }, "Duplicate Slack event, skipping");
      return;
    }
    this.dedupMap.set(eventId, Date.now());

    const normalized = normalizeSlackAppMention(
      eventPayload.event,
      eventId,
      this.config.gatewayConfig,
    );
    if (!normalized) {
      log.info(
        { eventId, channel: eventPayload.event.channel },
        "Slack event dropped by normalization/routing",
      );
      return;
    }

    this.onEvent(normalized);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer) return;

    const backoff = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, this.reconnectAttempt),
      MAX_BACKOFF_MS,
    );
    // Add jitter: 0-50% of backoff
    const jitter = Math.random() * backoff * 0.5;
    const delay = Math.round(backoff + jitter);

    log.info({ attempt: this.reconnectAttempt, delayMs: delay }, "Scheduling Socket Mode reconnect");
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        log.error({ err }, "Reconnect failed");
      });
    }, delay);
  }

  private startDedupCleanup(): void {
    this.stopDedupCleanup();
    this.dedupCleanupTimer = setInterval(() => {
      const now = Date.now();
      let evicted = 0;
      for (const [key, timestamp] of this.dedupMap) {
        if (now - timestamp > DEDUP_TTL_MS) {
          this.dedupMap.delete(key);
          evicted++;
        }
      }
      if (evicted > 0) {
        log.debug({ evicted }, "Evicted expired Slack event dedup entries");
      }
    }, DEDUP_CLEANUP_INTERVAL_MS);
  }

  private stopDedupCleanup(): void {
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = null;
    }
  }
}

/**
 * Factory function for creating a Slack Socket Mode client.
 */
export function createSlackSocketModeClient(
  config: SlackSocketModeConfig,
  onEvent: (event: NormalizedSlackEvent) => void,
): SlackSocketModeClient {
  return new SlackSocketModeClient(config, onEvent);
}
