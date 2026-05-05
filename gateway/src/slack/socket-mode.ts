import { buildSlackUserLabelMap } from "@vellumai/slack-text";
import { getLogger } from "../logger.js";
import { fetchImpl } from "../fetch.js";
import type { GatewayConfig } from "../config.js";
import { SlackStore } from "../db/slack-store.js";
import { isRejection, resolveAssistant } from "../routing/resolve-assistant.js";
import {
  CatchupAbortSignal,
  fetchChannelHistorySince,
  fetchThreadRepliesSince,
  runWithConcurrency,
  type SlackHistoryMessage,
} from "./slack-web.js";
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
const USER_RESOLVE_TIMEOUT_MS = 3_000;

/**
 * Reconnect catch-up bounds.
 *
 * `MAX_LOOKBACK_MS` caps how far back we'll ask Slack for missed messages.
 * Sleeps longer than this fall back to the daemon's existing inbound-
 * triggered backfill (JARVIS-643) once new live events resume.
 *
 * `SAFETY_OVERLAP_MS` widens the `oldest` window slightly past the
 * persisted watermark so a non-mention event that advanced the watermark
 * cannot silently mask an earlier missed mention. Resulting overlap is
 * absorbed by the compound `msg:${channel}:${ts}` dedup key.
 *
 * `HISTORY_LIMIT` and `CONCURRENCY` bound API budget per reconnect.
 */
const CATCHUP_MAX_LOOKBACK_MS = 60 * 60 * 1_000;
const CATCHUP_SAFETY_OVERLAP_MS = 60 * 1_000;
const CATCHUP_HISTORY_LIMIT = 50;
const CATCHUP_CONCURRENCY = 4;

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
  private emitQueues: Map<string, Promise<void>> | undefined = new Map();

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
        warnOnMissingSlackScopes(resp.headers.get("x-oauth-scopes") ?? "");

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
   * Register a thread as active so future replies (without @mention) are
   * forwarded. `channelId` is required so reconnect catch-up can scope a
   * `conversations.replies` fetch to the right channel.
   */
  trackThread(threadTs: string, channelId: string): void {
    this.store.trackThread(threadTs, channelId, ACTIVE_THREAD_TTL_MS);
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
        // Recover messages that arrived during the reconnect gap (Slack
        // does not buffer Socket Mode events during disconnects). Runs
        // off the open handler so initial-start, normal reconnect, and
        // sleep/wake force-reconnect all share the same recovery path.
        // Errors are swallowed inside replayMissedEvents — a failed
        // catch-up should never destabilize the live socket.
        void this.replayMissedEvents(ws);
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
        event_time?: number;
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
    if (!eventPayload.event_id) return;

    this.processEventPayload({
      event_id: eventPayload.event_id,
      event_time: eventPayload.event_time,
      event: eventPayload.event,
    });
  }

  /**
   * Filter, deduplicate, advance the watermark, and dispatch a single
   * Slack event payload. Shared by the live Socket Mode path
   * (`handleMessage`) and the reconnect catch-up path
   * (`replayMissedEvents`) so both flows enforce identical filters,
   * dedup, and ordering semantics.
   *
   * The `event_id` may be either a real Slack ID (live path) or a
   * synthetic `replay:${channel}:${ts}` ID (replay path). Both flow
   * through the same compound dedup table so the two paths never
   * double-emit a message that arrived on both.
   */
  private processEventPayload(eventPayload: {
    event_id: string;
    event_time?: number;
    event:
      | SlackAppMentionEvent
      | SlackDirectMessageEvent
      | SlackChannelMessageEvent
      | SlackMessageChangedEvent
      | SlackMessageDeletedEvent
      | SlackReactionAddedEvent
      | SlackReactionRemovedEvent;
  }): void {
    const event = eventPayload.event;
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
          this.store.hasThread(
            messageDeletedEvent.previous_message.thread_ts,
          )) ||
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

    // Compound dedup. Live events are keyed by Slack `event_id`; replay
    // events are keyed by `replay:${channel}:${ts}`. Both also write a
    // `msg:${channel}:${ts}` key when the event has a stable
    // (channel, ts) identity, so a message that arrives via both paths
    // is deduped on the second arrival regardless of which came first.
    const eventId = eventPayload.event_id;
    const messageKey = computeMessageDedupKey(event);
    if (this.store.hasEvent(eventId)) {
      log.debug({ eventId }, "Duplicate Slack event, skipping");
      return;
    }
    if (messageKey && this.store.hasEvent(messageKey)) {
      log.debug(
        { eventId, messageKey },
        "Slack event already seen via paired path, skipping",
      );
      return;
    }
    this.store.markEventSeen(eventId, DEDUP_TTL_MS);
    if (messageKey) {
      this.store.markEventSeen(messageKey, DEDUP_TTL_MS);
    }

    // Advance the catch-up watermark before dispatch.
    //
    // Trade-off: emit happens off the per-channel `emitQueues` chain, which
    // is in-memory and not persisted. The cases worth thinking about are:
    //
    //   - daemon wedged, gateway alive: the queue stalls but does not drop;
    //     it drains when the daemon recovers. No loss.
    //   - gateway crash with daemon healthy: messages on the wire that have
    //     not yet been dedup-written are lost in memory, but the next
    //     reconnect refetches them via the watermark + 60s overlap. No loss.
    //   - gateway crash AND daemon outage simultaneously: the in-memory
    //     queue evaporates AND this watermark write has already advanced
    //     past the unsent messages, so the next reconnect will not refetch
    //     them. Genuinely lost.
    //
    // We accept the third case because the alternatives all regress
    // something else: advancing after successful emit makes a slow emit
    // stall the watermark and trigger wasteful refetch loops on every
    // reconnect during transient slowness, and a later message in the same
    // queue can still leapfrog the failed earlier one, so it does not
    // actually fix the silent-skip. A persistent emit outbox would cover
    // it, but that is a larger feature. The compensating daemon-side
    // reactive backfill (`triggerSlackThreadBackfillIfNeeded`) hydrates
    // thread context as soon as any follow-up message arrives, narrowing
    // the user-visible blast radius to "fully missed mention with no
    // follow-up, during a simultaneous gateway crash + daemon outage".
    const watermarkTs = extractEventWatermarkTs(event, eventPayload.event_time);
    if (watermarkTs) {
      this.store.setLastSeenTsIfGreater(watermarkTs);
    }

    if (isAppMention) {
      const appMentionEvent = event as SlackAppMentionEvent;
      const threadTs = appMentionEvent.thread_ts ?? appMentionEvent.ts;
      const routing = resolveAssistant(
        this.config.gatewayConfig,
        appMentionEvent.channel,
        appMentionEvent.user,
      );
      if (threadTs && !isRejection(routing) && appMentionEvent.channel) {
        this.store.trackThread(
          threadTs,
          appMentionEvent.channel,
          ACTIVE_THREAD_TTL_MS,
        );
      }
    }

    this.enqueueNormalizeAndEmit(
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

  private extractTextBearingContent(
    event:
      | SlackAppMentionEvent
      | SlackDirectMessageEvent
      | SlackChannelMessageEvent
      | SlackMessageChangedEvent
      | SlackMessageDeletedEvent
      | SlackReactionAddedEvent
      | SlackReactionRemovedEvent,
  ): string | undefined {
    if (
      event.type === "message" &&
      (event as SlackMessageChangedEvent).subtype === "message_changed"
    ) {
      return (event as SlackMessageChangedEvent).message?.text;
    }

    if (event.type === "app_mention" || event.type === "message") {
      return (event as SlackAppMentionEvent | SlackDirectMessageEvent).text;
    }

    return undefined;
  }

  private async resolveMentionLabelsForText(
    text: string,
  ): Promise<Record<string, string>> {
    return buildSlackUserLabelMap(
      [text],
      async (id): Promise<string | undefined> => {
        const userInfo = await Promise.race([
          resolveSlackUser(id, this.config.botToken),
          new Promise<undefined>((resolve) =>
            setTimeout(resolve, USER_RESOLVE_TIMEOUT_MS),
          ),
        ]);
        if (!userInfo) return undefined;
        return userInfo.displayName || userInfo.username;
      },
    );
  }

  private enqueueNormalizeAndEmit(
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
    const queues = (this.emitQueues ??= new Map());
    const orderingKey = this.getEventOrderingKey(event, eventId);
    const previous = queues.get(orderingKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() =>
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
        ),
      );

    queues.set(orderingKey, current);
    void current
      .catch((err: unknown) => {
        log.error({ err, eventId }, "Slack event normalization failed");
      })
      .finally(() => {
        if (queues.get(orderingKey) === current) {
          queues.delete(orderingKey);
        }
      });
  }

  private getEventOrderingKey(
    event:
      | SlackAppMentionEvent
      | SlackDirectMessageEvent
      | SlackChannelMessageEvent
      | SlackMessageChangedEvent
      | SlackMessageDeletedEvent
      | SlackReactionAddedEvent
      | SlackReactionRemovedEvent,
    eventId: string,
  ): string {
    if (event.type === "reaction_added" || event.type === "reaction_removed") {
      const reaction = event as
        | SlackReactionAddedEvent
        | SlackReactionRemovedEvent;
      return `${reaction.item.channel}:${reaction.item.ts}`;
    }

    if (
      event.type === "message" &&
      (event as SlackMessageChangedEvent).subtype === "message_changed"
    ) {
      const changed = event as SlackMessageChangedEvent;
      return `${changed.channel}:${changed.message.thread_ts ?? changed.message.ts ?? eventId}`;
    }

    if (
      event.type === "message" &&
      (event as SlackMessageDeletedEvent).subtype === "message_deleted"
    ) {
      const deleted = event as SlackMessageDeletedEvent;
      return `${deleted.channel}:${deleted.previous_message?.thread_ts ?? deleted.deleted_ts ?? eventId}`;
    }

    const message = event as
      | SlackAppMentionEvent
      | SlackDirectMessageEvent
      | SlackChannelMessageEvent;
    return `${message.channel}:${message.thread_ts ?? message.ts ?? eventId}`;
  }

  private async normalizeAndEmit(
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
  ): Promise<void> {
    const text = this.extractTextBearingContent(event);
    const userLabels = text ? await this.resolveMentionLabelsForText(text) : {};
    const renderContext = { userLabels };

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
        this.config.botUserId,
        this.config.botToken,
        renderContext,
      );
    } else if (isMessageChanged) {
      normalized = normalizeSlackMessageEdit(
        event as SlackMessageChangedEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botUserId,
        renderContext,
      );
    } else if (isMessageDeleted) {
      normalized = normalizeSlackMessageDelete(
        event as SlackMessageDeletedEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botUserId,
      );
    } else if (isActiveThreadReply) {
      normalized = normalizeSlackChannelMessage(
        event as SlackChannelMessageEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botUserId,
        this.config.botToken,
        renderContext,
      );
    } else if (isDm) {
      normalized = normalizeSlackDirectMessage(
        event as SlackDirectMessageEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botUserId,
        this.config.botToken,
        renderContext,
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

    // Track threads only for real participation signals so follow-up replies
    // continue after app mentions and admitted messages, without reactions,
    // edits, or deletes arming unrelated threads.
    const threadTs = normalized.threadTs;
    const channelId = normalized.event.message.conversationExternalId;
    const shouldTrackActiveThread = isAppMention || isActiveThreadReply;
    if (shouldTrackActiveThread && threadTs && channelId) {
      this.store.trackThread(threadTs, channelId, ACTIVE_THREAD_TTL_MS);
    }

    // Enrich actor display name if the sync cache missed.
    // resolveSlackUser is fast on cache hit and deduplicates in-flight fetches,
    // so this adds negligible latency on subsequent messages. A 3s timeout
    // ensures the event is always emitted even if the Slack API hangs.
    const actor = normalized.event.actor;
    if (actor?.actorExternalId && !actor.displayName) {
      const mentionedLabel = userLabels[actor.actorExternalId];
      if (mentionedLabel) {
        actor.displayName = mentionedLabel;
      }

      const userInfo = await Promise.race([
        resolveSlackUser(actor.actorExternalId, this.config.botToken),
        new Promise<undefined>((resolve) =>
          setTimeout(resolve, USER_RESOLVE_TIMEOUT_MS),
        ),
      ]);
      if (userInfo) {
        actor.displayName = userInfo.displayName;
        actor.username = userInfo.username;
      }
    }

    this.onEvent(normalized);
  }

  /**
   * Catch up on messages that arrived during the reconnect window.
   *
   * Slack does not buffer Socket Mode events for disconnected clients
   * (see https://api.slack.com/apis/socket-mode), so on reconnect we
   * fetch a bounded slice of `conversations.history` /
   * `conversations.replies` since the persisted watermark and feed any
   * recovered messages back through `processEventPayload`. Compound
   * dedup (`msg:${channel}:${ts}`) prevents double-emit if the same
   * message also arrives via the live socket.
   *
   * Scope:
   *   - Routed channels (gateway routing entries)
   *   - Active threads (`slack_active_threads`)
   *   - Known DM channels (`contact_channels` rows of type `slack` with
   *     a `D…` external chat id)
   *
   * Brand-new mentions in unrouted, never-engaged channels are not
   * recoverable here — the daemon's existing inbound-triggered backfill
   * (`triggerSlackThreadBackfillIfNeeded`, `tryBackfillSlackDmIfCold`)
   * will hydrate context once the next live event arrives.
   */
  private async replayMissedEvents(ownerWs: WebSocket): Promise<void> {
    // Bail if a fresh forceReconnect has replaced the active socket
    // before the async work began. Without this gate, a stale generation
    // could fan out catch-up traffic that races with the new connection.
    if (this.ws !== ownerWs) return;

    const botToken = this.config.botToken;
    if (!botToken) return;

    // Bootstrap before the bot-identity check. The bot-identity check below
    // can keep returning early across reconnects if `auth.test` failed
    // transiently in `start()` and never retried — gating bootstrap on it
    // would leave the watermark unwritten for the entire degraded session,
    // and the eventual restart with a working `auth.test` would bootstrap
    // fresh against "now then" rather than "now at first ws.open", silently
    // widening the unrecoverable window. Bootstrap is identity-agnostic, so
    // run it first; the actual replay still requires `botUserId` and is
    // gated below.
    const persisted = this.store.getLastSeenTs();
    if (!persisted) {
      this.store.setLastSeenTsIfGreater(toSlackTs(Date.now()));
      log.info(
        "Slack catch-up: bootstrapped watermark, skipping initial replay",
      );
      return;
    }

    const botUserId = this.config.botUserId;
    if (!botUserId) {
      log.debug("Skipping reconnect catch-up: bot user id not yet resolved");
      return;
    }

    const minOldestMs = Date.now() - CATCHUP_MAX_LOOKBACK_MS;
    const persistedMs = Math.floor(Number(persisted) * 1_000);
    const overlapMs = Math.max(persistedMs - CATCHUP_SAFETY_OVERLAP_MS, 0);
    const oldestMs = Math.max(overlapMs, minOldestMs);
    const oldest = toSlackTs(oldestMs);

    const routedChannels = new Set<string>();
    for (const entry of this.config.gatewayConfig.routingEntries) {
      // routingEntries is shared across channels (Slack, Telegram, WhatsApp,
      // …), so filter to keys that look like Slack conversation IDs. Slack
      // IDs always begin with C (public channel), D (DM/IM), or G (private
      // channel / multi-person IM) — see
      // https://api.slack.com/types/conversation.
      if (
        entry.type === "conversation_id" &&
        isSlackConversationId(entry.key)
      ) {
        routedChannels.add(entry.key);
      }
    }
    const dmChannels = this.store.listKnownSlackDmChannels();
    for (const channel of dmChannels) routedChannels.add(channel);

    const activeThreads = this.store.listActiveThreadsWithChannel();

    log.info(
      {
        oldest,
        channels: routedChannels.size,
        threads: activeThreads.length,
      },
      "Slack reconnect catch-up starting",
    );

    let recovered = 0;
    const abort = new CatchupAbortSignal();

    // Channel/DM history fan-out. We use conversations.history rather than
    // conversations.replies for top-level channels because we want
    // any unseen top-level message — replies in tracked threads are
    // covered separately below.
    const channelTasks = Array.from(routedChannels).map((channel) => {
      return async () => {
        if (this.ws !== ownerWs || abort.aborted) return;
        const result = await fetchChannelHistorySince({
          botToken,
          channel,
          oldest,
          limit: CATCHUP_HISTORY_LIMIT,
          abort,
        });
        if (this.ws !== ownerWs) return;
        for (const msg of sortMessagesAscendingByTs(result.messages)) {
          if (this.injectReplayMessage(channel, msg, botUserId)) recovered++;
        }
      };
    });

    const threadTasks = activeThreads.map(({ channelId, threadTs }) => {
      return async () => {
        if (this.ws !== ownerWs || abort.aborted) return;
        const result = await fetchThreadRepliesSince({
          botToken,
          channel: channelId,
          threadTs,
          oldest,
          limit: CATCHUP_HISTORY_LIMIT,
          abort,
        });
        if (this.ws !== ownerWs) return;
        for (const msg of sortMessagesAscendingByTs(result.messages)) {
          // conversations.replies always returns the thread parent as the
          // first element regardless of `oldest` / `inclusive` — see
          // https://api.slack.com/methods/conversations.replies. The parent
          // was already processed when the thread was first tracked; replay
          // is for catching up on missed *replies*. Compound dedup would
          // catch a same-day re-emission, but for long-lived active threads
          // (TTL refreshed past the dedup window) the dedup row could have
          // expired, so filter explicitly.
          if (msg.ts === threadTs) continue;
          if (this.injectReplayMessage(channelId, msg, botUserId)) recovered++;
        }
      };
    });

    try {
      await runWithConcurrency(
        [...channelTasks, ...threadTasks],
        CATCHUP_CONCURRENCY,
      );
    } catch (err) {
      log.warn({ err }, "Slack reconnect catch-up encountered an error");
    }

    log.info({ recovered, oldest }, "Slack reconnect catch-up complete");
  }

  /**
   * Build a synthetic events_api envelope for a recovered message and
   * dispatch it through the shared `processEventPayload` path. Returns
   * true if the message was passed through to processing (subject to
   * filter/dedup), false if it was skipped at this stage (no `ts`,
   * bot's own message, or other shape that the live filter would also
   * drop).
   */
  private injectReplayMessage(
    channel: string,
    msg: SlackHistoryMessage,
    botUserId: string,
  ): boolean {
    if (!msg.ts) return false;

    // Skip the bot's own outbound messages and edits/deletes — the live
    // filter would already drop these and replaying them risks loops.
    if (msg.user === botUserId) return false;
    if (msg.bot_id) return false;
    if (
      msg.subtype &&
      msg.subtype !== "thread_broadcast" &&
      msg.subtype !== "file_share"
    ) {
      return false;
    }

    const mentionsBot = msg.text?.includes(`<@${botUserId}>`) ?? false;
    const isDm = channel.startsWith("D");
    // DMs are always delivered as `type: "message"` with `channel_type: "im"`
    // by live Slack, even when the bot is `<@U…>`-mentioned in the body —
    // Slack only emits `app_mention` for non-DM channels. Synthesizing a DM
    // as `app_mention` would route through `normalizeSlackAppMention`, which
    // (intentionally) lacks the DM default-assistant fallback that
    // `normalizeSlackDirectMessage` provides, so an unrouted DM @-mention
    // would silently drop in `unmappedPolicy: "reject"` deployments.
    const eventType: "app_mention" | "message" =
      mentionsBot && !isDm ? "app_mention" : "message";

    // Pass through `subtype`, `files`, `attachments`, and `blocks` so the
    // synthetic event has the same shape as a live Slack event for the
    // same message. Without this, recovered `file_share` messages would be
    // emitted as text-only and downstream attachment handling would diverge
    // between the live and replay paths. See
    // https://api.slack.com/events/message and
    // https://api.slack.com/events/app_mention for the live event shape.
    const syntheticEvent = {
      type: eventType,
      user: msg.user ?? "",
      text: msg.text ?? "",
      ts: msg.ts,
      thread_ts: msg.thread_ts,
      channel,
      channel_type: isDm ? "im" : "channel",
      team: msg.team,
      ...(msg.subtype ? { subtype: msg.subtype } : {}),
      ...(msg.files ? { files: msg.files } : {}),
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
      ...(msg.blocks ? { blocks: msg.blocks } : {}),
    } as unknown as
      | SlackAppMentionEvent
      | SlackDirectMessageEvent
      | SlackChannelMessageEvent;

    this.processEventPayload({
      event_id: `replay:${channel}:${msg.ts}`,
      event_time: Math.floor(Number(msg.ts)) || undefined,
      event: syntheticEvent,
    });
    return true;
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
 * Compute a stable `msg:${channel}:${ts}` dedup key for events that carry
 * a (channel, ts) identity. Used so the live and reconnect-replay paths
 * dedup symmetrically — a message that arrives via both paths is rejected
 * on the second arrival regardless of which came first.
 *
 * Returns undefined for events without a stable message identity (e.g.
 * `message_changed`, `message_deleted`, reactions). Those rely on their
 * Slack `event_id` for dedup; replay never synthesizes them.
 */
function computeMessageDedupKey(event: {
  type?: string;
  subtype?: string;
  channel?: string;
  ts?: string;
}): string | undefined {
  // Restrict to top-level message-shaped events. Edits/deletes carry a
  // separate `previous_message`/`message` payload and don't need this key
  // because the replay path doesn't synthesize them.
  if (event.type !== "message" && event.type !== "app_mention") {
    return undefined;
  }
  if (
    event.subtype === "message_changed" ||
    event.subtype === "message_deleted"
  ) {
    return undefined;
  }
  if (!event.channel || !event.ts) return undefined;
  return `msg:${event.channel}:${event.ts}`;
}

/**
 * Extract the watermark timestamp for an event. Prefers the message ts,
 * falling back to envelope `event_time` for events that don't carry their
 * own ts (reactions). Returns a Slack-format `<seconds>.<micros>` string
 * or undefined when no usable timestamp is present.
 */
function extractEventWatermarkTs(
  event: {
    ts?: string;
    item?: { ts?: string };
    deleted_ts?: string;
    message?: { ts?: string };
  },
  envelopeEventTime: number | undefined,
): string | undefined {
  if (event.ts) return event.ts;
  if (event.message?.ts) return event.message.ts;
  if (event.deleted_ts) return event.deleted_ts;
  if (event.item?.ts) return event.item.ts;
  if (envelopeEventTime) return `${envelopeEventTime}.000000`;
  return undefined;
}

/** Convert millisecond epoch to a Slack `<seconds>.<micros>` timestamp string. */
function toSlackTs(ms: number): string {
  const secs = Math.floor(ms / 1_000);
  const micros = Math.floor((ms % 1_000) * 1_000);
  return `${secs}.${String(micros).padStart(6, "0")}`;
}

/**
 * True if `id` looks like a Slack conversation ID. Slack IDs are 9–11
 * uppercase-alphanumeric characters prefixed with `C` (public channel),
 * `D` (direct message / IM), or `G` (private channel / multi-person IM).
 * See https://api.slack.com/types/conversation.
 */
function isSlackConversationId(id: string): boolean {
  return /^[CDG][A-Z0-9]+$/.test(id);
}

/**
 * Result of inspecting a bot-token scope header. Exposed so callers can
 * decide how to surface missing scopes (logging, telemetry, both) without
 * coupling the inspection logic to a specific logger.
 */
export interface SlackScopeCheckResult {
  filesReadMissing: boolean;
  missingHistoryScopes: string[];
}

/**
 * Inspect a bot-token scope header and return which optional scopes are
 * absent. Pure / no side effects — exists alongside
 * `warnOnMissingSlackScopes` so it can be unit-tested without observing
 * logger output.
 *
 *   - `files:read` — required for downloading file/image attachments.
 *   - `*:history` (channels/im/groups/mpim) — required for
 *     `conversations.history` and `conversations.replies`. Slack returns
 *     `ok: false, error: "missing_scope"` per channel type that is missing
 *     the corresponding scope (see
 *     https://api.slack.com/methods/conversations.history), and the
 *     catch-up error handler treats that as zero messages.
 */
export function inspectSlackScopes(
  scopesHeader: string,
): SlackScopeCheckResult {
  const scopes = new Set(
    scopesHeader
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return {
    filesReadMissing: !scopes.has("files:read"),
    missingHistoryScopes: [
      "channels:history",
      "im:history",
      "groups:history",
      "mpim:history",
    ].filter((scope) => !scopes.has(scope)),
  };
}

/**
 * Emit warnings for any bot-token scopes whose absence makes the gateway
 * silently degrade rather than fail loudly. Without this startup check the
 * user sees a successful boot followed by quiet "recovered: 0" log lines on
 * every reconnect, with no signal that catch-up is no-op'ing on
 * `missing_scope`.
 */
export function warnOnMissingSlackScopes(scopesHeader: string): void {
  const { filesReadMissing, missingHistoryScopes } =
    inspectSlackScopes(scopesHeader);
  if (filesReadMissing) {
    log.warn(
      "Slack bot token is missing the 'files:read' scope — file/image " +
        "attachments will not be downloaded. Add 'files:read' to your " +
        "Slack app's Bot Token Scopes and reinstall the app.",
    );
  }
  if (missingHistoryScopes.length > 0) {
    log.warn(
      { missingHistoryScopes },
      "Slack bot token is missing one or more *:history scopes — " +
        "reconnect catch-up will not recover messages from the affected " +
        "channel types. Add the missing scopes to your Slack app's Bot " +
        "Token Scopes and reinstall the app.",
    );
  }
}

/**
 * Sort Slack messages by `ts` ascending so they replay through the
 * per-channel emit queue in chronological order. `conversations.history`
 * returns messages newest-first
 * (https://api.slack.com/methods/conversations.history) and
 * `conversations.replies` makes no strict ordering guarantee beyond
 * "parent first", so we sort defensively rather than rely on either API's
 * order. Without this, a flurry of missed messages emits in reverse
 * order — the runtime sees the latest user message before the earlier
 * ones it depends on. Messages without a `ts` are dropped by
 * `injectReplayMessage` anyway; sort them last so they don't perturb
 * the order of the rest.
 */
function sortMessagesAscendingByTs<T extends { ts?: string }>(
  messages: readonly T[],
): T[] {
  return [...messages].sort((a, b) => {
    const aTs = a.ts ? Number(a.ts) : Number.POSITIVE_INFINITY;
    const bTs = b.ts ? Number(b.ts) : Number.POSITIVE_INFINITY;
    return aTs - bTs;
  });
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
