import { getLogger } from "../logger.js";
import { fetchImpl } from "../fetch.js";
import type { GatewayConfig } from "../config.js";
import { SlackStore } from "../db/slack-store.js";
import {
  normalizeSlackAppMention,
  normalizeSlackDirectMessage,
  normalizeSlackChannelMessage,
  normalizeSlackMessageEdit,
  normalizeSlackMessageDelete,
  normalizeSlackBlockActions,
  normalizeSlackReactionAdded,
  normalizeSlackReactionRemoved,
  resolveSlackUser,
  type SlackAppMentionEvent,
  type SlackDirectMessageEvent,
  type SlackChannelMessageEvent,
  type SlackMessageChangedEvent,
  type SlackMessageDeletedEvent,
  type SlackBlockActionsPayload,
  type SlackReactionAddedEvent,
  type SlackReactionRemovedEvent,
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
  /** Bot's display name, resolved at startup via auth.test. */
  botUsername?: string;
  /** Workspace/team name, resolved at startup via auth.test. */
  teamName?: string;
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
  private connecting = false;
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private store: SlackStore;

  constructor(
    config: SlackSocketModeConfig,
    onEvent: (event: NormalizedSlackEvent) => void,
  ) {
    this.config = config;
    this.onEvent = onEvent;
    this.store = new SlackStore();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startDedupCleanup();

    // Resolve bot identity via auth.test so we can filter the bot's own DMs
    if (
      !this.config.botUserId ||
      !this.config.botUsername ||
      !this.config.teamName
    ) {
      try {
        const resp = await fetchImpl("https://slack.com/api/auth.test", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.config.botToken}` },
        });
        const data = (await resp.json()) as {
          ok: boolean;
          user_id?: string;
          user?: string;
          team?: string;
        };
        if (!data.ok) {
          throw new Error(
            "Slack auth.test failed: bot token is invalid or expired",
          );
        }
        if (data.user_id) {
          this.config.botUserId = data.user_id;
        }
        if (data.user) {
          this.config.botUsername = data.user;
        }
        if (data.team) {
          this.config.teamName = data.team;
        }
        // Warn if the bot token is missing scopes needed for file downloads.
        const scopes = resp.headers.get("x-oauth-scopes") ?? "";
        if (!scopes.split(",").some((s) => s.trim() === "files:read")) {
          log.warn(
            "Slack bot token is missing the 'files:read' scope — file/image " +
              "attachments will not be downloaded. Add 'files:read' to your " +
              "Slack app's Bot Token Scopes and reinstall the app.",
          );
        }

        log.info(
          {
            botUserId: data.user_id,
            botUsername: data.user,
            teamName: data.team,
          },
          "Resolved Slack bot identity",
        );
      } catch (err) {
        // Explicit auth rejection (data.ok === false) is fatal — the bot
        // token is invalid and retrying won't help.
        const isAuthRejection =
          err instanceof Error &&
          err.message.includes("bot token is invalid or expired");
        if (isAuthRejection) {
          this.running = false;
          this.stopDedupCleanup();
          throw err;
        }
        // Transient fetch/network errors — warn and proceed to connect(),
        // which has its own reconnect logic with backoff.
        log.warn({ err }, "Failed to resolve bot identity via auth.test");
      }
    }

    await this.connect();
  }

  stop(): void {
    this.running = false;
    this.connecting = false;
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
   * Force-close the current WebSocket and reconnect immediately.
   * Used by the sleep/wake detector to recover from half-open connections
   * that survive system sleep.
   *
   * Waits for the old socket to fully close before connecting a new one
   * to prevent overlapping connections where stale message events could
   * be ACKed on the wrong socket.
   */
  forceReconnect(): void {
    if (!this.running) return;

    log.info("Force-reconnecting Slack Socket Mode (sleep/wake recovery)");

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectAttempt = 0;

    const oldWs = this.ws;
    this.ws = null;

    // If a connect() call is already in-flight (awaiting getWebSocketUrl),
    // don't start another one — the in-flight attempt will complete and
    // establish a fresh connection. We still tear down the old socket and
    // cancel the reconnect timer above so there's no stale state.
    if (this.connecting) {
      log.info(
        "Connect already in-flight, skipping duplicate — tearing down old socket only",
      );
      if (oldWs) {
        try {
          oldWs.close(1000, "force reconnect");
        } catch {
          // ignore
        }
      }
      return;
    }

    if (!oldWs || oldWs.readyState === WebSocket.CLOSED) {
      this.connect().catch((err) => {
        log.error({ err }, "Force reconnect failed");
      });
      return;
    }

    // Wait for the old socket to fully close before opening a new one.
    // Use a timeout to avoid blocking indefinitely on half-open sockets
    // that may never emit a close event (the exact scenario that triggers
    // a force reconnect after sleep).
    const CLOSE_TIMEOUT_MS = 5_000;
    let settled = false;

    const proceed = () => {
      if (settled) return;
      settled = true;
      this.connect().catch((err) => {
        log.error({ err }, "Force reconnect failed");
      });
    };

    oldWs.addEventListener("close", proceed, { once: true });

    setTimeout(() => {
      if (!settled) {
        log.warn(
          "Old Slack socket did not close within timeout, proceeding with reconnect",
        );
        proceed();
      }
    }, CLOSE_TIMEOUT_MS);

    try {
      oldWs.close(1000, "force reconnect");
    } catch {
      // Socket may already be in a broken state — proceed immediately
      proceed();
    }
  }

  /**
   * Register a thread as active so future replies (without @mention) are forwarded.
   */
  trackThread(threadTs: string): void {
    this.store.trackThread(threadTs, ACTIVE_THREAD_TTL_MS);
  }

  /**
   * Returns true when the gateway has a configured `conversation_id` routing
   * entry for the given channel — i.e. the bot is subscribed to that channel.
   *
   * Used by the reaction filter to admit reactions on any subscribed channel,
   * not just those in tracked bot threads.
   */
  private isChannelSubscribed(channel: string): boolean {
    for (const entry of this.config.gatewayConfig.routingEntries) {
      if (entry.type === "conversation_id" && entry.key === channel) {
        return true;
      }
    }
    return false;
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    if (this.connecting) return;
    this.connecting = true;

    let wsUrl: string;
    try {
      wsUrl = await this.getWebSocketUrl();
    } catch (err) {
      log.error({ err }, "Failed to obtain Socket Mode WebSocket URL");
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }

    log.info("Connecting to Slack Socket Mode");

    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      this.connecting = false;

      ws.addEventListener("open", () => {
        log.info("Slack Socket Mode connected");
        this.reconnectAttempt = 0;
      });

      ws.addEventListener("message", (messageEvent) => {
        this.handleMessage(messageEvent.data as string, ws);
      });

      ws.addEventListener("close", (closeEvent) => {
        log.info(
          { code: closeEvent.code, reason: closeEvent.reason },
          "Slack Socket Mode disconnected",
        );
        // Only reconnect if this socket is still the active one.
        // forceReconnect nulls this.ws before initiating a new connection,
        // so a stale close event should be ignored.
        if (this.ws === ws) {
          this.ws = null;
          this.scheduleReconnect();
        }
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
      this.connecting = false;
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

  private handleMessage(raw: string, originWs: WebSocket): void {
    let envelope: {
      envelope_id?: string;
      type?: string;
      payload?: {
        event_id?: string;
        event?:
          | SlackAppMentionEvent
          | SlackDirectMessageEvent
          | SlackChannelMessageEvent
          | SlackMessageChangedEvent
          | SlackMessageDeletedEvent
          | SlackReactionAddedEvent
          | SlackReactionRemovedEvent;
        // Interactive payloads are delivered directly as the payload
        type?: string;
        trigger_id?: string;
        user?: { id: string; username?: string; name?: string };
        channel?: { id: string; name?: string };
        message?: { ts: string; thread_ts?: string; text?: string };
        actions?: SlackBlockActionsPayload["actions"];
      };
      reason?: string;
    };

    try {
      envelope = JSON.parse(raw);
    } catch {
      log.warn("Received non-JSON Socket Mode message");
      return;
    }

    // ACK every envelope on the socket that received it — never cross-ACK
    // onto a different connection (e.g. after forceReconnect replaces this.ws).
    if (envelope.envelope_id && originWs.readyState === WebSocket.OPEN) {
      originWs.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    // Handle disconnect type: Slack asks us to reconnect.
    // Only act if the requesting socket is still the active one —
    // a stale socket's disconnect should not tear down a new connection.
    if (envelope.type === "disconnect") {
      log.info(
        { reason: envelope.reason },
        "Slack requested disconnect, reconnecting",
      );
      if (this.ws === originWs) {
        try {
          this.ws.close(1000, "server requested disconnect");
        } catch {
          // ignore
        }
        this.ws = null;
        // Reconnect immediately (attempt 0 = minimal backoff)
        this.reconnectAttempt = 0;
        this.scheduleReconnect();
      }
      return;
    }

    // Handle interactive payloads (block_actions from Block Kit buttons)
    if (envelope.type === "interactive") {
      this.handleInteractive(envelope.payload);
      return;
    }

    // Only process events_api envelopes
    if (envelope.type !== "events_api") return;

    const eventPayload = envelope.payload;
    if (!eventPayload?.event) return;

    const event = eventPayload.event;

    if (!eventPayload.event_id) return;

    const dmEvent = event as SlackDirectMessageEvent;
    const channelEvent = event as SlackChannelMessageEvent;
    const messageChangedEvent = event as SlackMessageChangedEvent;
    const messageDeletedEvent = event as SlackMessageDeletedEvent;

    const isAppMention = event.type === "app_mention";
    const isMessageChangedRaw =
      event.type === "message" &&
      messageChangedEvent.subtype === "message_changed";
    // Accept message_changed in DMs, tracked bot threads, or any channel
    // the bot is explicitly subscribed to via a conversation_id routing
    // entry. The routing-entry check keeps Slack unfurl (link preview)
    // events in random channels from triggering the bot, while still
    // surfacing edits made to any message in a configured channel so the
    // daemon can correlate them with prior context.
    const isSubscribedChannel =
      !!messageChangedEvent.channel &&
      this.config.gatewayConfig.routingEntries.some(
        (entry) =>
          entry.type === "conversation_id" &&
          entry.key === messageChangedEvent.channel,
      );
    const isMessageChanged =
      isMessageChangedRaw &&
      (messageChangedEvent.channel_type === "im" ||
        (!!messageChangedEvent.message?.thread_ts &&
          this.store.hasThread(messageChangedEvent.message.thread_ts)) ||
        (!!messageChangedEvent.message?.ts &&
          this.store.hasThread(messageChangedEvent.message.ts)) ||
        isSubscribedChannel);
    // Admit message_deleted in DMs, tracked bot threads, or any channel the
    // bot is explicitly subscribed to via a conversation_id routing entry so
    // the daemon can mark the corresponding stored row deleted. The
    // routing-entry check mirrors message_changed's scoping above.
    const isMessageDeleted =
      event.type === "message" &&
      messageDeletedEvent.subtype === "message_deleted" &&
      !!messageDeletedEvent.deleted_ts &&
      (messageDeletedEvent.channel_type === "im" ||
        (!!messageDeletedEvent.previous_message?.thread_ts &&
          this.store.hasThread(messageDeletedEvent.previous_message.thread_ts)) ||
        (!!messageDeletedEvent.deleted_ts &&
          this.store.hasThread(messageDeletedEvent.deleted_ts)) ||
        (!!messageDeletedEvent.channel &&
          this.config.gatewayConfig.routingEntries.some(
            (entry) =>
              entry.type === "conversation_id" &&
              entry.key === messageDeletedEvent.channel,
          )));
    const isDm =
      event.type === "message" &&
      !isMessageChanged &&
      !isMessageDeleted &&
      dmEvent.channel_type === "im";
    const mentionsBot =
      this.config.botUserId &&
      channelEvent.text?.includes(`<@${this.config.botUserId}>`);
    const isActiveThreadReply =
      event.type === "message" &&
      !isMessageChanged &&
      !isMessageDeleted &&
      !isDm &&
      !mentionsBot &&
      !!channelEvent.thread_ts &&
      this.store.hasThread(channelEvent.thread_ts);

    // Forward reaction events on:
    //   1. messages in tracked bot threads (preserves original behavior), or
    //   2. messages in any channel the bot is subscribed to (a configured
    //      conversation_id routing entry, or any DM channel since DMs always
    //      route to the default assistant).
    // Both reaction_added and reaction_removed are admitted under the same
    // filter; the daemon dispatches by callbackData prefix.
    const reactionEvent = event as
      | SlackReactionAddedEvent
      | SlackReactionRemovedEvent;
    const reactionTargetChannel = reactionEvent.item?.channel;
    const reactionAdmitChannel =
      !!reactionTargetChannel &&
      (reactionTargetChannel.startsWith("D") ||
        this.isChannelSubscribed(reactionTargetChannel) ||
        (!!reactionEvent.item?.ts &&
          this.store.hasThread(reactionEvent.item.ts)));
    const isReactionAdded =
      event.type === "reaction_added" &&
      !!reactionEvent.item?.ts &&
      reactionAdmitChannel;
    const isReactionRemoved =
      event.type === "reaction_removed" &&
      !!reactionEvent.item?.ts &&
      reactionAdmitChannel;

    // Process app_mention events, DMs, message edits, message deletes, scoped reactions, and replies in active bot threads
    const matchedFilter = isAppMention
      ? "app_mention"
      : isDm
        ? "dm"
        : isMessageChanged
          ? "message_changed"
          : isMessageDeleted
            ? "message_deleted"
            : isReactionAdded
              ? "reaction_added"
              : isReactionRemoved
                ? "reaction_removed"
                : isActiveThreadReply
                  ? "active_thread_reply"
                  : null;

    if (!matchedFilter) {
      log.debug(
        {
          eventId: eventPayload.event_id,
          type: event.type,
          subtype: (event as { subtype?: string }).subtype,
          channel: (event as { channel?: string }).channel,
          channelType: (event as { channel_type?: string }).channel_type,
          user: (event as { user?: string }).user,
          hasThreadTs: !!(event as { thread_ts?: string }).thread_ts,
          threadTs: (event as { thread_ts?: string }).thread_ts,
          isMessageChangedRaw,
          text: (event as { text?: string }).text?.slice(0, 80),
        },
        "Slack event dropped by filter",
      );
      return;
    }

    log.info(
      {
        eventId: eventPayload.event_id,
        filter: matchedFilter,
        type: event.type,
        channelType: (event as { channel_type?: string }).channel_type,
        channel: (event as { channel?: string }).channel,
        subtype: (event as { subtype?: string }).subtype,
        user: (event as { user?: string }).user,
        hasThreadTs: !!(event as { thread_ts?: string }).thread_ts,
      },
      "Slack event accepted by filter",
    );

    // Deduplicate on event_id
    const eventId = eventPayload.event_id;
    if (this.store.hasEvent(eventId)) {
      log.debug({ eventId }, "Duplicate Slack event, skipping");
      return;
    }
    this.store.markEventSeen(eventId, DEDUP_TTL_MS);

    this.normalizeAndEmit(
      event,
      eventId,
      isAppMention,
      isActiveThreadReply,
      isReactionAdded,
      isReactionRemoved,
      isMessageChanged,
      isMessageDeleted,
      isDm,
    );
  }

  private normalizeAndEmit(
    event:
      | SlackAppMentionEvent
      | SlackDirectMessageEvent
      | SlackChannelMessageEvent
      | SlackMessageChangedEvent
      | SlackMessageDeletedEvent
      | SlackReactionAddedEvent
      | SlackReactionRemovedEvent,
    eventId: string,
    isAppMention: boolean,
    isActiveThreadReply: boolean,
    isReactionAdded: boolean,
    isReactionRemoved: boolean,
    isMessageChanged: boolean,
    isMessageDeleted: boolean,
    isDm: boolean,
  ): void {
    let normalized: NormalizedSlackEvent | null;
    if (isReactionAdded) {
      normalized = normalizeSlackReactionAdded(
        event as SlackReactionAddedEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botUserId,
      );
    } else if (isReactionRemoved) {
      normalized = normalizeSlackReactionRemoved(
        event as SlackReactionRemovedEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botUserId,
      );
    } else if (isAppMention) {
      normalized = normalizeSlackAppMention(
        event as SlackAppMentionEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botToken,
      );
    } else if (isMessageChanged) {
      normalized = normalizeSlackMessageEdit(
        event as SlackMessageChangedEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botUserId,
      );
    } else if (isMessageDeleted) {
      normalized = normalizeSlackMessageDelete(
        event as SlackMessageDeletedEvent,
        eventId,
        this.config.gatewayConfig,
      );
    } else if (isActiveThreadReply) {
      normalized = normalizeSlackChannelMessage(
        event as SlackChannelMessageEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botUserId,
        this.config.botToken,
      );
    } else if (isDm) {
      normalized = normalizeSlackDirectMessage(
        event as SlackDirectMessageEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botUserId,
        this.config.botToken,
      );
    } else {
      log.warn(
        {
          eventId,
          type: event.type,
          channel: (event as { channel?: string }).channel,
        },
        "Slack event passed filter but no normalizer matched — dropping",
      );
      return;
    }

    if (!normalized) {
      log.info(
        {
          eventId,
          channel: (event as { channel?: string }).channel,
          type: event.type,
        },
        "Slack event dropped by normalization/routing",
      );
      return;
    }

    // Enrich actor display name if the sync cache missed.
    // resolveSlackUser is fast on cache hit and deduplicates in-flight fetches,
    // so this adds negligible latency on subsequent messages. A 3s timeout
    // ensures the event is always emitted even if the Slack API hangs.
    const actor = normalized.event.actor;
    if (actor?.actorExternalId && !actor.displayName) {
      const USER_RESOLVE_TIMEOUT_MS = 3_000;
      Promise.race([
        resolveSlackUser(actor.actorExternalId, this.config.botToken),
        new Promise<undefined>((r) => setTimeout(r, USER_RESOLVE_TIMEOUT_MS)),
      ])
        .then((userInfo) => {
          if (userInfo) {
            actor.displayName = userInfo.displayName;
            actor.username = userInfo.username;
          }
          this.onEvent(normalized!);
        })
        .catch(() => {
          this.onEvent(normalized!);
        });
      return;
    }

    this.onEvent(normalized);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleInteractive(payload: Record<string, any> | undefined): void {
    if (!payload) return;

    // Only handle block_actions (from Block Kit buttons)
    if (payload.type !== "block_actions") return;

    // First try to normalize as a channel-scoped block_actions event
    const normalized = normalizeSlackBlockActions(
      payload as unknown as SlackBlockActionsPayload,
      payload.envelope_id ?? "unknown",
      this.config.gatewayConfig,
    );
    if (normalized) {
      this.onEvent(normalized);
    }
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
      const evicted = this.store.cleanupExpiredEvents();
      if (evicted > 0) {
        log.debug({ evicted }, "Evicted expired Slack event dedup entries");
      }
      const threadEvicted = this.store.cleanupExpiredThreads();
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
