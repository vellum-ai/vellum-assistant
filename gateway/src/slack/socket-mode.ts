import {
  buildSlackChannelLabelMap,
  buildSlackUserLabelMap,
} from "@vellumai/slack-text";
import { getLogger } from "../logger.js";
import { fetchImpl } from "../fetch.js";
import type { GatewayConfig } from "../config.js";
import { SlackStore } from "../db/slack-store.js";
import { isRejection, resolveAssistant } from "../routing/resolve-assistant.js";
import {
  SLACK_THREAD_ALREADY_MUTED,
  SLACK_THREAD_MUTE_SUCCESS,
} from "../webhook-copy.js";
import {
  CatchupAbortSignal,
  fetchChannelHistorySince,
  fetchThreadRepliesSince,
  runWithConcurrency,
  type SlackHistoryMessage,
} from "./slack-web.js";
import { isSlackDmChannel } from "./channel.js";
import {
  normalizeSlackAppMention,
  normalizeSlackDirectMessage,
  normalizeSlackChannelMessage,
  normalizeSlackMessageEdit,
  normalizeSlackMessageDelete,
  normalizeSlackBlockActions,
  normalizeSlackReactionAdded,
  normalizeSlackReactionRemoved,
  enrichNormalizedActor,
  resolveSlackChannel,
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
  type SlackTextRenderContext,
} from "./normalize.js";

const log = getLogger("slack-socket-mode");

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const ACTIVE_THREAD_TTL_MS = 24 * 60 * 60 * 1_000;
const SLACK_RESOLVE_TIMEOUT_MS = 3_000;

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
const SLACK_MUTE_COMMANDS = new Set(["detach", "mute"]);

export type SlackThreadMode = "mention_only" | "mention_then_thread";

export type SlackSocketModeConfig = {
  appToken: string;
  botToken: string;
  gatewayConfig: GatewayConfig;
  /**
   * Bot's own Slack user ID. Required for self-filtering — when undefined,
   * the gateway cannot distinguish its own outbound echoes from inbound
   * messages and refuses to process events (fail-closed).
   *
   * Resolved once via `auth.test` and persisted to SQLite so subsequent
   * startups load it without depending on a successful API call.
   */
  botUserId?: string;
  /** Bot's display name, resolved at startup via auth.test. */
  botUsername?: string;
  /** Slack workspace/team name, resolved at startup via auth.test. */
  teamName?: string;
  /**
   * Controls whether the bot auto-follows threads after an initial @mention.
   * - `mention_only`: only respond to explicit @mentions (no thread tracking).
   * - `mention_then_thread`: after the first @mention, listen to all
   *   subsequent replies in the thread for 24h.
   */
  threadMode: SlackThreadMode;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeLeadingBotMentions(text: string, botUserId?: string): string {
  let remaining = text.trim();
  if (!remaining) return "";

  if (botUserId) {
    const mentionPrefix = new RegExp(`^<@${escapeRegExp(botUserId)}>\\s*`);
    while (mentionPrefix.test(remaining)) {
      remaining = remaining.replace(mentionPrefix, "").trim();
    }
    return remaining;
  }

  return remaining.replace(/^<@[UW][A-Z0-9]+>\s*/, "").trim();
}

function isSlackMuteCommand(text: string, botUserId?: string): boolean {
  return SLACK_MUTE_COMMANDS.has(
    removeLeadingBotMentions(text, botUserId).toLowerCase(),
  );
}

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

    await this.resolveBotIdentity();
    await this.connect();
  }

  /**
   * Resolve the bot's Slack user ID — the identity used to filter the
   * bot's own outbound echoes from inbound events.
   *
   * Resolution strategy (in order):
   *   1. Already populated in config (e.g. by a previous call) → no-op.
   *   2. Call `auth.test` to get the authoritative answer from Slack.
   *      On success, persist the result to SQLite so future startups
   *      don't depend on a successful API call.
   *   3. On transient `auth.test` failure, fall back to the persisted
   *      identity from SQLite (the last known good value).
   *   4. If neither API nor persistence has a value (first-ever start
   *      with a transient failure), log an error. `processEventPayload`
   *      will refuse to forward events until identity is resolved
   *      (fail-closed).
   *
   * Auth rejection (invalid_auth, token_revoked, etc.) is fatal — a bad
   * token cannot self-heal. Server-side errors (internal_error, fatal_error)
   * are treated as transient and fall through to persistence.
   */
  private async resolveBotIdentity(): Promise<void> {
    if (this.config.botUserId && this.config.botUsername) {
      return;
    }

    // Try the live API first — this is the authoritative source.
    try {
      const resp = await fetchImpl("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.botToken}` },
      });
      const data = (await resp.json()) as {
        ok: boolean;
        error?: string;
        user_id?: string;
        user?: string;
        team?: string;
      };

      if (!data.ok) {
        // Distinguish auth rejection (fatal — bad token) from server-side
        // errors (transient — Slack internal_error, fatal_error, etc.).
        // https://api.slack.com/methods/auth.test#errors
        const FATAL_AUTH_ERRORS: ReadonlySet<string> = new Set([
          "invalid_auth",
          "not_authed",
          "token_revoked",
          "token_expired",
          "account_inactive",
          "enterprise_is_restricted",
        ]);
        if (FATAL_AUTH_ERRORS.has(data.error ?? "")) {
          this.running = false;
          this.stopDedupCleanup();
          throw new Error(`Slack auth.test rejected: ${data.error}`);
        }
        // Server-side error — treat as transient, fall through to persistence.
        log.warn(
          { error: data.error },
          "Slack auth.test returned a server-side error — checking persisted identity",
        );
      } else {
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

        // Persist for future startups.
        if (data.user_id) {
          this.store.setBotIdentity({
            userId: data.user_id,
            username: data.user ?? null,
            metadata: data.team ? { teamName: data.team } : null,
          });
        }

        log.info(
          {
            botUserId: data.user_id,
            botUsername: data.user,
            teamName: data.team,
          },
          "Resolved Slack bot identity via auth.test",
        );
        return;
      }
    } catch (err) {
      // Re-throw fatal auth rejections — they can't self-heal.
      if (
        err instanceof Error &&
        err.message.startsWith("Slack auth.test rejected:")
      ) {
        throw err;
      }
      log.warn(
        { err },
        "Failed to resolve bot identity via auth.test — checking persisted identity",
      );
    }

    // Transient API failure — fall back to the last persisted identity.
    const persisted = this.store.getBotIdentity("slack");
    if (persisted) {
      this.config.botUserId = persisted.userId;
      this.config.botUsername = persisted.username ?? this.config.botUsername;
      const meta = persisted.metadata as { teamName?: string } | null;
      this.config.teamName = meta?.teamName ?? this.config.teamName;
      log.info(
        {
          botUserId: persisted.userId,
          botUsername: persisted.username,
          teamName: meta?.teamName,
        },
        "Loaded Slack bot identity from persisted store (auth.test was unavailable)",
      );
      return;
    }

    // Neither API nor persistence — first-ever start with a transient failure.
    log.error(
      "Unable to resolve Slack bot identity: auth.test failed and no persisted identity exists. " +
        "Events will not be processed until identity is resolved (fail-closed). " +
        "The next successful WebSocket reconnect will retry.",
    );
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

  private handleSlackMuteCommand(event: SlackAppMentionEvent): boolean {
    if (!isSlackMuteCommand(event.text, this.config.botUserId)) {
      return false;
    }

    const channelId = event.channel;
    const threadTs = event.thread_ts ?? event.ts;
    if (!channelId || !threadTs) {
      log.warn(
        { channelId, threadTs },
        "Slack mute command missing channel or thread timestamp",
      );
      return true;
    }

    const detached = this.store.detachThread(threadTs, channelId);
    log.info(
      { channelId, threadTs, detached },
      "Handled Slack mute command without runtime dispatch",
    );

    const confirmationText = detached
      ? SLACK_THREAD_MUTE_SUCCESS
      : SLACK_THREAD_ALREADY_MUTED;
    this.sendSlackMuteConfirmation(channelId, threadTs, confirmationText).catch(
      (err) => {
        log.warn(
          { err, channelId, threadTs },
          "Slack thread muted, but confirmation message failed",
        );
      },
    );

    return true;
  }

  private async sendSlackMuteConfirmation(
    channelId: string,
    threadTs: string,
    text: string,
  ): Promise<void> {
    const resp = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: channelId,
        text,
        thread_ts: threadTs,
      }),
    });
    const data = (await resp.json()) as { ok?: boolean; error?: string };
    if (!resp.ok || data.ok === false) {
      const reason = data.error ?? `HTTP ${resp.status}`;
      throw new Error(`Slack chat.postMessage failed: ${reason}`);
    }
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

  /**
   * Extract the Slack user ID from any event type. Returns undefined for
   * events that don't carry a user field (e.g. some system subtypes).
   */
  private extractEventUser(
    event:
      | SlackAppMentionEvent
      | SlackDirectMessageEvent
      | SlackChannelMessageEvent
      | SlackMessageChangedEvent
      | SlackMessageDeletedEvent
      | SlackReactionAddedEvent
      | SlackReactionRemovedEvent,
  ): string | undefined {
    // message_changed: the author is on the inner `message` object.
    if (
      event.type === "message" &&
      (event as SlackMessageChangedEvent).subtype === "message_changed"
    ) {
      return (event as SlackMessageChangedEvent).message?.user;
    }
    // message_deleted: the author is on previous_message.
    if (
      event.type === "message" &&
      (event as SlackMessageDeletedEvent).subtype === "message_deleted"
    ) {
      return (event as SlackMessageDeletedEvent).previous_message?.user;
    }
    // All other event types carry `user` at the top level.
    return (event as { user?: string }).user;
  }

  /**
   * Side-effect-only handler for the bot's own thread replies. The event
   * itself is always dropped (the caller returns after this), but thread
   * tracking is armed so follow-up human replies pass the active-thread
   * filter.
   */
  private maybeTrackBotOwnThreadReply(
    event:
      | SlackAppMentionEvent
      | SlackDirectMessageEvent
      | SlackChannelMessageEvent
      | SlackMessageChangedEvent
      | SlackMessageDeletedEvent
      | SlackReactionAddedEvent
      | SlackReactionRemovedEvent,
  ): void {
    if (this.config.threadMode !== "mention_then_thread") return;

    const channelEvent = event as SlackChannelMessageEvent;
    const subtype = (event as SlackMessageChangedEvent).subtype;
    if (
      event.type !== "message" ||
      subtype === "message_changed" ||
      subtype === "message_deleted" ||
      !channelEvent.thread_ts ||
      !channelEvent.channel
    ) {
      return;
    }
    if (!this.shouldTrackBotOwnThreadReply(channelEvent.channel)) return;

    if (this.store.isThreadDetached(channelEvent.thread_ts)) {
      log.info(
        { channel: channelEvent.channel, threadTs: channelEvent.thread_ts },
        "Skipped tracking bot's own reply in explicitly muted thread",
      );
      return;
    }

    this.store.trackThread(
      channelEvent.thread_ts,
      channelEvent.channel,
      ACTIVE_THREAD_TTL_MS,
    );
    log.info(
      { channel: channelEvent.channel, threadTs: channelEvent.thread_ts },
      "Tracked thread after bot's own thread reply",
    );
  }

  /**
   * Tracking-eligibility check for the bot's own thread replies (the
   * Socket Mode echo of a proactive chat.postMessage). The echo is never
   * forwarded — this only decides whether the thread is armed in
   * `slack_active_threads`.
   *
   * The echo's author is the bot user, which never matches a human
   * `actor_id` route, so resolving routing by the event's sender would
   * reject every echo in actor-routed workspaces. Instead the thread is
   * eligible when the channel could route an inbound human message:
   *
   *   - a channel-scoped route applies — a `conversation_id` entry for
   *     the channel, or the `default` unmapped policy — regardless of
   *     sender; or
   *   - the workspace routes by actor (at least one Slack-shaped
   *     `actor_id` entry). Per-actor routing is not channel-scoped, so
   *     any thread the bot posts into may receive replies from routed
   *     humans.
   *
   * Arming a thread never loosens forwarding: thread replies admitted by
   * the active-thread filter still re-resolve routing with the human
   * sender at normalize time, and unrouted senders are dropped there.
   */
  private shouldTrackBotOwnThreadReply(channel: string): boolean {
    // Empty actor ID: matches channel-scoped routes (conversation_id or
    // default policy) only, never an actor_id entry.
    const channelRouting = resolveAssistant(
      this.config.gatewayConfig,
      channel,
      "",
    );
    if (!isRejection(channelRouting)) return true;
    // routingEntries is shared across channels (Slack, Telegram, …);
    // only Slack-shaped actor keys make Slack channels eligible.
    return this.config.gatewayConfig.routingEntries.some(
      (entry) => entry.type === "actor_id" && isSlackUserId(entry.key),
    );
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
        // Retry bot identity resolution on every reconnect so a transient
        // auth.test failure at startup is self-healing. Once resolved, the
        // check in resolveBotIdentity short-circuits immediately (no await
        // delay on the normal path).
        //
        // Replay must wait for identity resolution — without botUserId the
        // catch-up path cannot self-filter replayed events, and if identity
        // is still unknown processEventPayload will drop them (fail-closed).
        void this.resolveBotIdentity()
          .catch((err) => {
            log.error({ err }, "Bot identity resolution failed on reconnect");
          })
          .then(() => {
            // Recover messages that arrived during the reconnect gap (Slack
            // does not buffer Socket Mode events during disconnects). Runs
            // off the open handler so initial-start, normal reconnect, and
            // sleep/wake force-reconnect all share the same recovery path.
            // Errors are swallowed inside replayMissedEvents — a failed
            // catch-up should never destabilize the live socket.
            return this.replayMissedEvents(ws);
          });
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
        team_id?: string;
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

    // Slack carries the workspace ID as `team_id` on the events_api payload;
    // inner events don't reliably carry `team` (app_mention and channel
    // messages commonly omit it). Stamp the payload-level team onto the
    // event so normalization can capture the actor's team. An event-level
    // `team` (e.g. a Slack Connect sender's home workspace) takes precedence.
    const innerEvent = eventPayload.event as { team?: string };
    if (eventPayload.team_id && !innerEvent.team) {
      innerEvent.team = eventPayload.team_id;
    }

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
    const botUserId = this.config.botUserId;

    // ── Fail-closed: reject events when bot identity is unknown ────────
    // Without botUserId the gateway cannot distinguish its own outbound
    // echoes from legitimate inbound messages. Processing them would
    // trigger spurious access-request notifications for the bot's own
    // Slack user ID. Reject all events until identity is resolved — the
    // reconnect path retries auth.test on every WebSocket open.
    if (!botUserId) {
      log.warn(
        { eventId: eventPayload.event_id },
        "Dropping event: bot identity not yet resolved (fail-closed)",
      );
      return;
    }

    // ── Single self-filter: drop the bot's own messages ────────────────
    // Slack's Socket Mode delivers the bot's own outbound messages back
    // as inbound events (DM echoes, thread reply echoes, etc.). This is
    // the one structural filter point — every event with the bot as author
    // is dropped here, before any normalization or routing.
    const eventUser = this.extractEventUser(event);
    if (eventUser === botUserId) {
      // Exception: the bot's own thread replies are used to arm thread
      // tracking (so follow-up human replies are forwarded). This is a
      // side effect only — the event itself is still dropped.
      this.maybeTrackBotOwnThreadReply(event);
      return;
    }

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
      (isSlackDmChannel(
        messageChangedEvent.channel,
        messageChangedEvent.channel_type,
      ) ||
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
      (isSlackDmChannel(
        messageDeletedEvent.channel,
        messageDeletedEvent.channel_type,
      ) ||
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
      isSlackDmChannel(dmEvent.channel, dmEvent.channel_type);
    const mentionsBot = channelEvent.text?.includes(`<@${botUserId}>`);
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
      (isSlackDmChannel(reactionTargetChannel) ||
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
                : isActiveThreadReply &&
                    this.config.threadMode === "mention_then_thread"
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

    if (
      isAppMention &&
      this.handleSlackMuteCommand(event as SlackAppMentionEvent)
    ) {
      return;
    }

    if (isAppMention) {
      const appMentionEvent = event as SlackAppMentionEvent;
      const threadTs = appMentionEvent.thread_ts ?? appMentionEvent.ts;
      const routing = resolveAssistant(
        this.config.gatewayConfig,
        appMentionEvent.channel,
        appMentionEvent.user,
      );
      if (
        this.config.threadMode === "mention_then_thread" &&
        threadTs &&
        !isRejection(routing) &&
        appMentionEvent.channel
      ) {
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
            setTimeout(resolve, SLACK_RESOLVE_TIMEOUT_MS),
          ),
        ]);
        if (!userInfo) return undefined;
        return userInfo.displayName || userInfo.username;
      },
    );
  }

  private async resolveChannelLabelsForText(
    text: string,
  ): Promise<Record<string, string>> {
    return buildSlackChannelLabelMap(
      [text],
      async (id): Promise<string | undefined> => {
        const channelInfo = await Promise.race([
          resolveSlackChannel(id, this.config.botToken),
          new Promise<undefined>((resolve) =>
            setTimeout(resolve, SLACK_RESOLVE_TIMEOUT_MS),
          ),
        ]);
        return channelInfo?.name;
      },
    );
  }

  private async resolveTextRenderContext(
    text: string,
  ): Promise<SlackTextRenderContext> {
    const [userLabels, channelLabels] = await Promise.all([
      this.resolveMentionLabelsForText(text),
      this.resolveChannelLabelsForText(text),
    ]);
    return { userLabels, channelLabels };
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
    const renderContext = text ? await this.resolveTextRenderContext(text) : {};
    const userLabels = renderContext.userLabels ?? {};

    let normalized: NormalizedSlackEvent | null;
    if (isReactionAdded) {
      normalized = normalizeSlackReactionAdded(
        event as SlackReactionAddedEvent,
        eventId,
        this.config.gatewayConfig,
      );
    } else if (isReactionRemoved) {
      normalized = normalizeSlackReactionRemoved(
        event as SlackReactionRemovedEvent,
        eventId,
        this.config.gatewayConfig,
      );
    } else if (isAppMention) {
      normalized = normalizeSlackAppMention(
        event as SlackAppMentionEvent,
        eventId,
        this.config.gatewayConfig,
        this.config.botToken,
        renderContext,
      );
    } else if (isMessageChanged) {
      normalized = normalizeSlackMessageEdit(
        event as SlackMessageChangedEvent,
        eventId,
        this.config.gatewayConfig,
        renderContext,
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
        this.config.botToken,
        renderContext,
      );
    } else if (isDm) {
      normalized = normalizeSlackDirectMessage(
        event as SlackDirectMessageEvent,
        eventId,
        this.config.gatewayConfig,
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
    const shouldTrackActiveThread =
      this.config.threadMode === "mention_then_thread" &&
      (isAppMention || isActiveThreadReply);
    if (shouldTrackActiveThread && threadTs && channelId) {
      this.store.trackThread(threadTs, channelId, ACTIVE_THREAD_TTL_MS);
    }

    // Enrich actor metadata when the sync cache missed.
    // resolveSlackUser is fast on cache hit, deduplicates in-flight fetches,
    // and returns undefined on failure. We block here so trust signals
    // (isStranger, isRestricted) are available before ACL enforcement, but
    // bound the wait to prevent a hanging TCP connection from stalling all
    // event processing.
    const actor = normalized.event.actor;
    if (actor?.actorExternalId && !actor.displayName) {
      const mentionedLabel = userLabels[actor.actorExternalId];
      if (mentionedLabel) {
        actor.displayName = mentionedLabel;
      }

      const userInfo = await Promise.race([
        resolveSlackUser(actor.actorExternalId, this.config.botToken),
        new Promise<undefined>((resolve) =>
          setTimeout(resolve, SLACK_RESOLVE_TIMEOUT_MS),
        ),
      ]);
      if (userInfo) {
        // Also re-runs bot-sender classification: an is_bot-only bot (no
        // top-level bot_id) is undetectable during cache-only normalization.
        enrichNormalizedActor(normalized, userInfo);
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

    // Bootstrap the watermark on first-ever connect so reconnect catch-up
    // has a starting point. This is identity-agnostic — safe to run even
    // before botUserId is resolved.
    const persisted = this.store.getLastSeenTs();
    if (!persisted) {
      this.store.setLastSeenTsIfGreater(toSlackTs(Date.now()));
      log.info(
        "Slack catch-up: bootstrapped watermark, skipping initial replay",
      );
      return;
    }

    // Replay requires botUserId so injectReplayMessage can filter the
    // bot's own history messages. processEventPayload also rejects events
    // when botUserId is undefined (fail-closed), but filtering at the
    // replay level avoids wasting API calls on messages we'd drop anyway.
    const botUserId = this.config.botUserId;
    if (!botUserId) {
      log.warn("Skipping reconnect catch-up: bot identity not yet resolved");
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
    // `conversations.history`/`replies` carry no `channel_type`, so classify
    // DMs by the conversation ID prefix.
    const isDm = isSlackDmChannel(channel);
    // Slack only emits `app_mention` in non-DM channels, even when the bot is
    // `<@U…>`-mentioned in a DM body. Synthesizing a DM as `app_mention` would
    // route through `normalizeSlackAppMention`, which (intentionally) lacks the
    // DM default-assistant fallback that `normalizeSlackDirectMessage`
    // provides, so an unrouted DM @-mention would silently drop in
    // `unmappedPolicy: "reject"` deployments.
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
 * True if `id` looks like a Slack user ID: uppercase-alphanumeric,
 * prefixed with `U` or `W` (Enterprise Grid) — see
 * https://api.slack.com/changelog/2016-08-11-user-id-format-changes.
 * Used to distinguish Slack `actor_id` routing entries from other
 * channels' actor keys (Telegram numeric IDs, phone numbers, …) in the
 * shared routingEntries list.
 */
function isSlackUserId(id: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(id);
}

/**
 * Result of inspecting a bot-token scope header. Exposed so callers can
 * decide how to surface missing scopes (logging, telemetry, both) without
 * coupling the inspection logic to a specific logger.
 */
export interface SlackScopeCheckResult {
  filesReadMissing: boolean;
  missingHistoryScopes: string[];
  missingConversationInfoScopes: string[];
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
 *   - `*:read` (channels/im/groups/mpim) — required for
 *     `conversations.info`, used to resolve Slack channel refs in inbound
 *     message text.
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
    missingConversationInfoScopes: [
      "channels:read",
      "im:read",
      "groups:read",
      "mpim:read",
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
  const {
    filesReadMissing,
    missingHistoryScopes,
    missingConversationInfoScopes,
  } = inspectSlackScopes(scopesHeader);
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
  if (missingConversationInfoScopes.length > 0) {
    log.warn(
      { missingConversationInfoScopes },
      "Slack bot token is missing one or more *:read scopes — " +
        "inbound channel references may render as #unknown-channel for the " +
        "affected channel types. Add the missing scopes to your Slack app's " +
        "Bot Token Scopes and reinstall the app.",
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
