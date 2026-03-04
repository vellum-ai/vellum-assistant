import { getLogger } from "../logger.js";
import { fetchImpl } from "../fetch.js";
import type { GatewayConfig } from "../config.js";
import {
  normalizeSlackAppMention,
  normalizeSlackDirectMessage,
  normalizeSlackChannelMessage,
  type SlackAppMentionEvent,
  type SlackDirectMessageEvent,
  type SlackChannelMessageEvent,
  type NormalizedSlackEvent,
} from "./normalize.js";

const log = getLogger("slack-socket-mode");

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const ACTIVE_THREAD_TTL_MS = 24 * 60 * 60 * 1_000;

export type SlackSocketModeConfig = {
  appToken: string;
  botToken: string;
  gatewayConfig: GatewayConfig;
  /** Bot's own Slack user ID, used to ignore the bot's own DMs. */
  botUserId?: string;
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
  private activeThreads = new Map<string, number>();

  constructor(
    config: SlackSocketModeConfig,
    onEvent: (event: NormalizedSlackEvent) => void,
  ) {
    this.config = config;
    this.onEvent = onEvent;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startDedupCleanup();

    // Resolve bot user ID via auth.test so we can filter the bot's own DMs
    if (!this.config.botUserId) {
      try {
        const resp = await fetchImpl("https://slack.com/api/auth.test", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.config.botToken}` },
        });
        const data = (await resp.json()) as { ok: boolean; user_id?: string };
        if (data.ok && data.user_id) {
          this.config.botUserId = data.user_id;
          log.info({ botUserId: data.user_id }, "Resolved Slack bot user ID");
        }
      } catch (err) {
        log.warn({ err }, "Failed to resolve bot user ID via auth.test");
      }
    }

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

  /**
   * Register a thread as active so future replies (without @mention) are forwarded.
   */
  trackThread(threadTs: string): void {
    this.activeThreads.set(threadTs, Date.now());
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
        log.info(
          { code: closeEvent.code, reason: closeEvent.reason },
          "Slack Socket Mode disconnected",
        );
        this.ws = null;
        this.scheduleReconnect();
      });

      ws.addEventListener("error", (errorEvent) => {
        log.error(
          { error: String(errorEvent) },
          "Slack Socket Mode WebSocket error",
        );
      });
    } catch (err) {
      log.error({ err }, "Failed to create WebSocket connection");
      this.ws = null;
      this.scheduleReconnect();
    }
  }

  private async getWebSocketUrl(): Promise<string> {
    const resp = await fetchImpl(
      "https://slack.com/api/apps.connections.open",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.appToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    if (!resp.ok) {
      throw new Error(`apps.connections.open HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as {
      ok: boolean;
      url?: string;
      error?: string;
    };
    if (!data.ok || !data.url) {
      throw new Error(
        `apps.connections.open failed: ${data.error ?? "unknown error"}`,
      );
    }

    return data.url;
  }

  private handleMessage(raw: string): void {
    let envelope: {
      envelope_id?: string;
      type?: string;
      payload?: {
        event_id?: string;
        event?:
          | SlackAppMentionEvent
          | SlackDirectMessageEvent
          | SlackChannelMessageEvent;
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
    if (
      envelope.envelope_id &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
      this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    // Handle disconnect type: Slack asks us to reconnect
    if (envelope.type === "disconnect") {
      log.info(
        { reason: envelope.reason },
        "Slack requested disconnect, reconnecting",
      );
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

    const event = eventPayload.event;
    const dmEvent = event as SlackDirectMessageEvent;
    const channelEvent = event as SlackChannelMessageEvent;

    const isAppMention = event.type === "app_mention";
    const isDm = event.type === "message" && dmEvent.channel_type === "im";
    const mentionsBot =
      this.config.botUserId &&
      channelEvent.text?.includes(`<@${this.config.botUserId}>`);
    const isActiveThreadReply =
      event.type === "message" &&
      !isDm &&
      !mentionsBot &&
      !!channelEvent.thread_ts &&
      this.activeThreads.has(channelEvent.thread_ts);

    // Process app_mention events, DMs, and replies in active bot threads
    if (!isAppMention && !isDm && !isActiveThreadReply) {
      return;
    }

    // Deduplicate on event_id
    const eventId = eventPayload.event_id;
    if (this.dedupMap.has(eventId)) {
      log.debug({ eventId }, "Duplicate Slack event, skipping");
      return;
    }
    this.dedupMap.set(eventId, Date.now());

    this.normalizeAndEmit(
      event,
      eventId,
      isAppMention,
      isActiveThreadReply,
      isDm,
    );
  }

  private normalizeAndEmit(
    event:
      | SlackAppMentionEvent
      | SlackDirectMessageEvent
      | SlackChannelMessageEvent,
    eventId: string,
    isAppMention: boolean,
    isActiveThreadReply: boolean,
    _isDm: boolean,
  ): void {
    let normalized: NormalizedSlackEvent | null;
    if (isAppMention) {
      normalized = normalizeSlackAppMention(
        event as SlackAppMentionEvent,
        eventId,
        this.config.gatewayConfig,
      );
    } else if (isActiveThreadReply) {
      normalized = normalizeSlackChannelMessage(
        event as SlackChannelMessageEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botUserId,
      );
    } else {
      normalized = normalizeSlackDirectMessage(
        event as SlackDirectMessageEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botUserId,
      );
    }

    if (!normalized) {
      log.info(
        { eventId, channel: event.channel, type: event.type },
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

    log.info(
      { attempt: this.reconnectAttempt, delayMs: delay },
      "Scheduling Socket Mode reconnect",
    );
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
      // Also clean up expired active threads
      let threadEvicted = 0;
      for (const [key, timestamp] of this.activeThreads) {
        if (now - timestamp > ACTIVE_THREAD_TTL_MS) {
          this.activeThreads.delete(key);
          threadEvicted++;
        }
      }
      if (threadEvicted > 0) {
        log.debug({ threadEvicted }, "Evicted expired active thread entries");
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
