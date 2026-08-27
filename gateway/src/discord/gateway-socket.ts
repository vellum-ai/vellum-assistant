/**
 * Discord Gateway WebSocket client — the lifecycle that wires the protocol
 * modules together.
 *
 *   connect → HELLO → IDENTIFY or RESUME (session-state's decision) →
 *   heartbeat loop with ACK watchdog + clock-jump detection → close-code
 *   taxonomy → backoff → reconnect
 *
 * Every recovery path funnels through `DiscordSessionState.nextConnection()`:
 * the taxonomy (or op 9) decides whether the session survives, the session
 * state decides where to connect and what to open with, and the backoff
 * decides when. Deliberate kills that intend to resume close with
 * {@link RESUMABLE_CLOSE_CODE}; the one outbound 1000 is `stop()`, which
 * tears the client down without consulting any of it.
 *
 * Two latches make a dead credential quiescent instead of a retry loop: a
 * REST 401 on `GET /gateway/bot` and a 4004 close both stop the client until
 * a credential change constructs a fresh one. Retrying either burns the
 * 1000/24h identify budget toward a token reset, and hammering Discord's REST
 * edge with 401s risks a Cloudflare IP ban on the operator's network.
 *
 * Sockets, timers, fetch, randomness, and the clock are all injectable so the
 * whole lifecycle is testable against a fake WebSocket without real time.
 */

import { getLogger } from "../logger.js";
import {
  defaultSchedule,
  type CancelTimer,
  type ScheduleFn,
} from "../util/schedule.js";
import { fetchImpl } from "../fetch.js";
import type { DiscordInboundEvent } from "../channels/inbound-event.js";
import type { ChannelConnectionHealth } from "../channels/types.js";
import { admitDiscordMessage } from "./admit.js";
import { AdmissionDropLog } from "./admission-log.js";
import {
  extractDiscordAttachmentMap,
  type DiscordAttachmentReference,
} from "./attachments.js";
import { ReconnectBackoff, SESSION_STABLE_AFTER_MS } from "./backoff.js";
import {
  RESUMABLE_CLOSE_CODE,
  fatalCloseDiagnostic,
  isClientFaultCloseCode,
  recoveryActionForCloseCode,
} from "./close-codes.js";
import { HeartbeatMonitor } from "./heartbeat.js";
import { DISCORD_GATEWAY_INTENTS } from "./intents.js";
import {
  DiscordGatewayPayloadSchema,
  DiscordHelloSchema,
  DiscordMessageCreateSchema,
  DiscordReadySchema,
  DiscordThreadListSchema,
  DISCORD_COMPONENT_TYPE_BUTTON,
  DISCORD_INTERACTION_CALLBACK_DEFERRED_UPDATE,
  DISCORD_INTERACTION_TYPE_MESSAGE_COMPONENT,
  DiscordInteractionSchema,
  DiscordMessageDeleteSchema,
  DiscordMessageReactionSchema,
  DiscordThreadSchema,
} from "./message-schemas.js";
import {
  normalizeDiscordInteraction,
  normalizeDiscordMessage,
  normalizeDiscordMessageDelete,
  normalizeDiscordMessageReaction,
  toAdmissionCandidate,
} from "./normalize.js";
import { DiscordSessionState } from "./session-state.js";
import { ThreadParentCache } from "./thread-parents.js";

const log = getLogger("discord-gateway");

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export type DiscordGatewayEventHandler = (
  event: DiscordInboundEvent,
  attachmentRefs?: Map<string, DiscordAttachmentReference>,
) => void;

/**
 * Floor for the `session_start_limit.remaining` warning. Steady state spends
 * a handful of identifies a day; dipping below this means something is
 * looping and the token is on a path toward Discord's automatic reset.
 */
const SESSION_START_REMAINING_WARN_FLOOR = 100;

/**
 * How long a fresh socket may sit without delivering op 10 HELLO before it is
 * treated as dead. Discord sends HELLO immediately on connect, so this only
 * trips on a transport that connected but went silent (half-open after a
 * sleep or NAT rebind) — the one state with no close event to recover from
 * and, before HELLO, no heartbeat watchdog armed. The kill closes with the
 * resumable code, so a false positive costs one resume.
 */
const HELLO_DEADLINE_MS = 30_000;

/**
 * Extra delay before re-IDENTIFYing after op 9 `d: false`: 1–5 s, uniform.
 * No longer in the official docs but universal library behavior — it paces
 * identify bursts when Discord invalidates many sessions at once, and costs
 * nothing.
 */
const OP9_REIDENTIFY_MIN_DELAY_MS = 1_000;
const OP9_REIDENTIFY_MAX_DELAY_MS = 5_000;

/** Gateway opcodes this client speaks. */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** The surface of a WebSocket this client uses, satisfiable by a fake. */
export interface GatewaySocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void;
}

export interface DiscordGatewayClientOptions {
  botToken: string;
  /**
   * A legacy install's persisted room restriction, read live per message so
   * an operator's edit applies without a restart. Returns undefined once the
   * config entry is cleared, which is the operator adopting the permission
   * model; nothing writes the entry anymore.
   */
  readLegacyAllowedChannelIds?: () => ReadonlySet<string> | undefined;
  fetchFn?: typeof fetchImpl;
  createSocket?: (url: string) => GatewaySocketLike;
  schedule?: ScheduleFn;
  random?: () => number;
  now?: () => number;
}

export class DiscordGatewayClient {
  private readonly botToken: string;
  private readonly readLegacyAllowedChannelIds?: () =>
    | ReadonlySet<string>
    | undefined;
  private readonly fetchFn: typeof fetchImpl;
  private readonly createSocket: (url: string) => GatewaySocketLike;
  private readonly schedule: ScheduleFn;
  private readonly random: () => number;

  private readonly heartbeat: HeartbeatMonitor;
  private readonly backoff: ReconnectBackoff;
  private readonly threadParents = new ThreadParentCache();
  private readonly admissionDropLog = new AdmissionDropLog();

  private sessionState: DiscordSessionState | null = null;
  private ws: GatewaySocketLike | null = null;
  /** What to open the current socket with once HELLO arrives. */
  private pendingAction: "resume" | "identify" = "identify";
  private botUserId: string | undefined;

  private running = false;
  /**
   * Set on fatal close codes and REST 401. A latched client never reconnects;
   * recovery is a credential change, which constructs a fresh client.
   */
  private latched = false;

  private cancelHeartbeatTimer: CancelTimer | null = null;
  private cancelHelloTimer: CancelTimer | null = null;
  private cancelReconnectTimer: CancelTimer | null = null;
  private cancelStabilityTimer: CancelTimer | null = null;

  constructor(
    options: DiscordGatewayClientOptions,
    private readonly onEvent: DiscordGatewayEventHandler,
  ) {
    this.botToken = options.botToken;
    this.readLegacyAllowedChannelIds = options.readLegacyAllowedChannelIds;
    this.fetchFn = options.fetchFn ?? fetchImpl;
    this.createSocket =
      options.createSocket ??
      ((url) => new WebSocket(url) as GatewaySocketLike);
    this.schedule = options.schedule ?? defaultSchedule;
    this.random = options.random ?? Math.random;
    this.heartbeat = new HeartbeatMonitor(this.random, options.now ?? Date.now);
    this.backoff = new ReconnectBackoff(this.random);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.bootstrap();
  }

  /**
   * Obtain the base Gateway URL and open the first socket. Re-entered by the
   * reconnect timer when a transient REST failure left the client without a
   * base URL; the retry is paced on the identify cap, since the attempt it
   * paces ends in an IDENTIFY.
   */
  private async bootstrap(): Promise<void> {
    const baseUrl = await this.fetchGatewayBaseUrl();
    if (!this.running || this.latched) {
      return;
    }
    if (!baseUrl) {
      this.scheduleReconnect();
      return;
    }
    this.sessionState = new DiscordSessionState(baseUrl);
    this.openSocket();
  }

  /**
   * Whether this client currently holds a live Gateway connection.
   *
   * Reported in the same shape as the other socket channels so a reader does
   * not need to know which protocol proved it. Discord's proof of liveness is
   * an op 11 ACK rather than a pong.
   *
   * `connected` requires an established session, not merely a socket pointer.
   * `openSocket` assigns `this.ws` as soon as the socket is constructed, and
   * the connection carries nothing until op 10 HELLO arrives, so a socket
   * whose handshake stalls would otherwise report itself live for the whole
   * HELLO deadline. A recorded heartbeat interval is the establishment
   * signal: it is set from HELLO and cleared on every reset.
   */
  getConnectionHealth(): ChannelConnectionHealth {
    return {
      connected:
        this.ws !== null && this.heartbeat.heartbeatIntervalMs !== undefined,
      lastLivenessAt: this.heartbeat.lastAckAt,
    };
  }

  /**
   * Deliberate teardown. Closes with 1000 — the session is intentionally
   * finished, so the taxonomy is never consulted.
   */
  stop(): void {
    this.running = false;
    this.cancelTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, "client shutdown");
      } catch {
        // Ignore close errors during shutdown.
      }
    }
  }

  /**
   * `GET /gateway/bot`: the base Gateway URL, plus the session-start budget.
   * Returns undefined on transient failure. A 401 latches the client —
   * retrying a dead token risks an IP-level Cloudflare ban on top of the
   * burned budget.
   */
  private async fetchGatewayBaseUrl(): Promise<string | undefined> {
    let response: Response;
    try {
      response = await this.fetchFn(`${DISCORD_API_BASE_URL}/gateway/bot`, {
        headers: { Authorization: `Bot ${this.botToken}` },
      });
    } catch (err) {
      log.warn({ err }, "GET /gateway/bot failed — will retry");
      return undefined;
    }

    if (response.status === 401) {
      this.latched = true;
      this.running = false;
      log.error(
        "Discord rejected the bot token (401). The connection stays down " +
          "until a fresh token from the Developer Portal is stored.",
      );
      return undefined;
    }
    if (!response.ok) {
      log.warn(
        { status: response.status },
        "GET /gateway/bot returned a non-OK status — will retry",
      );
      return undefined;
    }

    let body: {
      url?: string;
      session_start_limit?: { remaining?: number; total?: number };
    };
    try {
      body = (await response.json()) as typeof body;
    } catch (err) {
      log.warn(
        { err },
        "GET /gateway/bot returned malformed JSON — will retry",
      );
      return undefined;
    }
    if (typeof body.url !== "string" || body.url.length === 0) {
      log.warn("GET /gateway/bot response carried no Gateway URL — will retry");
      return undefined;
    }

    const remaining = body.session_start_limit?.remaining;
    if (
      typeof remaining === "number" &&
      remaining < SESSION_START_REMAINING_WARN_FLOOR
    ) {
      log.warn(
        { remaining, total: body.session_start_limit?.total },
        "Discord session-start budget is running low — something is " +
          "re-identifying too often; breaching the cap resets the bot token",
      );
    }
    return body.url;
  }

  private openSocket(): void {
    if (!this.running || this.latched || !this.sessionState) {
      return;
    }
    const plan = this.sessionState.nextConnection();
    this.pendingAction = plan.action;
    this.heartbeat.reset();

    let ws: GatewaySocketLike;
    try {
      ws = this.createSocket(plan.url);
    } catch (err) {
      log.error({ err }, "Failed to create Discord Gateway WebSocket");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    log.info({ action: plan.action }, "Connecting to Discord Gateway");

    ws.addEventListener("message", (event) => {
      if (this.ws === ws && typeof event.data === "string") {
        this.handleFrame(ws, event.data);
      }
    });
    ws.addEventListener("close", (event) => {
      // Deliberately killed sockets are nulled before closing, so a stale
      // close event never double-triggers recovery.
      if (this.ws === ws) {
        this.ws = null;
        this.handleClose(event.code);
      }
    });
    ws.addEventListener("error", (event) => {
      log.warn({ error: String(event) }, "Discord Gateway WebSocket error");
    });

    // Until HELLO arrives no heartbeat watchdog exists, so a socket that
    // connects but never speaks would otherwise hang the client forever.
    this.cancelHelloTimer = this.schedule(() => {
      this.cancelHelloTimer = null;
      if (this.ws === ws) {
        log.warn(
          "Discord Gateway socket delivered no HELLO within the deadline — " +
            "treating the connection as dead",
        );
        this.killAndRecover(ws, "no HELLO before deadline");
      }
    }, HELLO_DEADLINE_MS);
  }

  private handleFrame(ws: GatewaySocketLike, raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      log.warn("Received a non-JSON Discord Gateway frame");
      return;
    }
    const parsed = DiscordGatewayPayloadSchema.safeParse(json);
    if (!parsed.success || parsed.data.op === undefined) {
      log.warn("Received a malformed Discord Gateway frame");
      return;
    }
    const payload = parsed.data;
    this.sessionState?.noteSequence(payload.s);

    switch (payload.op) {
      case OP.HELLO:
        this.handleHello(ws, payload.d);
        return;
      case OP.HEARTBEAT_ACK:
        this.heartbeat.noteAck();
        return;
      case OP.HEARTBEAT:
        // The server may request a beat at any time; respond immediately.
        this.sendHeartbeat(ws);
        return;
      case OP.RECONNECT:
        // Routine (deploys / node drains). Act on the op itself rather than
        // waiting for the close that follows a few seconds later.
        log.info("Discord sent op 7 RECONNECT — resuming on a fresh socket");
        this.killAndRecover(ws, "op 7 RECONNECT");
        return;
      case OP.INVALID_SESSION:
        this.handleInvalidSession(ws, payload.d === true);
        return;
      case OP.DISPATCH:
        this.handleDispatch(payload.t ?? undefined, payload.d);
        return;
      default:
        return;
    }
  }

  private handleHello(ws: GatewaySocketLike, data: unknown): void {
    this.cancelHelloTimer?.();
    this.cancelHelloTimer = null;
    const hello = DiscordHelloSchema.safeParse(data);
    const intervalMs = hello.success
      ? hello.data.heartbeat_interval
      : undefined;
    if (intervalMs === undefined || intervalMs <= 0) {
      log.error("Discord HELLO carried no usable heartbeat interval");
      this.killAndRecover(ws, "malformed HELLO");
      return;
    }
    const firstBeatDelay = this.heartbeat.noteHello(intervalMs);
    this.scheduleHeartbeatTick(ws, firstBeatDelay);

    if (this.pendingAction === "resume") {
      const resume = this.sessionState?.resumePayload();
      if (resume) {
        ws.send(
          JSON.stringify({
            op: OP.RESUME,
            d: { token: this.botToken, ...resume },
          }),
        );
        return;
      }
      // The session evaporated between planning and HELLO; fall through.
    }
    ws.send(
      JSON.stringify({
        op: OP.IDENTIFY,
        d: {
          token: this.botToken,
          intents: DISCORD_GATEWAY_INTENTS,
          properties: {
            os: process.platform,
            browser: "vellum-gateway",
            device: "vellum-gateway",
          },
        },
      }),
    );
  }

  private scheduleHeartbeatTick(ws: GatewaySocketLike, delayMs: number): void {
    this.cancelHeartbeatTimer?.();
    this.cancelHeartbeatTimer = this.schedule(() => {
      this.cancelHeartbeatTimer = null;
      if (this.ws !== ws) {
        return;
      }
      // Clock jump first: after a sleep the socket is usually silently dead,
      // and beating it would only start an ACK window we already know the
      // answer to. The kill closes with a resumable code, so a false positive
      // costs one resume.
      if (this.heartbeat.detectedClockJump()) {
        log.warn(
          "Heartbeat tick arrived far past its interval — treating the " +
            "connection as dead after a suspend and resuming",
        );
        this.killAndRecover(ws, "clock jump");
        return;
      }
      if (this.heartbeat.isZombie()) {
        log.warn(
          "Previous heartbeat was never acknowledged — killing the zombie " +
            "connection and resuming",
        );
        this.killAndRecover(ws, "missed heartbeat ACK");
        return;
      }
      this.sendHeartbeat(ws);
      const intervalMs = this.heartbeat.heartbeatIntervalMs;
      if (intervalMs !== undefined) {
        this.scheduleHeartbeatTick(ws, intervalMs);
      }
    }, delayMs);
  }

  private sendHeartbeat(ws: GatewaySocketLike): void {
    const seq = this.sessionState?.resumePayload()?.seq ?? null;
    try {
      ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: seq }));
      this.heartbeat.noteBeatSent();
    } catch (err) {
      log.warn({ err }, "Failed to send heartbeat");
    }
  }

  private handleInvalidSession(
    ws: GatewaySocketLike,
    resumable: boolean,
  ): void {
    if (resumable) {
      log.info("Discord sent op 9 (resumable) — resuming on a fresh socket");
      this.killAndRecover(ws, "op 9 resumable");
      return;
    }
    log.info("Discord invalidated the session — re-identifying");
    this.sessionState?.invalidate();
    const pacing =
      OP9_REIDENTIFY_MIN_DELAY_MS +
      this.random() *
        (OP9_REIDENTIFY_MAX_DELAY_MS - OP9_REIDENTIFY_MIN_DELAY_MS);
    this.killAndRecover(ws, "op 9 invalid session", pacing);
  }

  /**
   * Abandon `ws`, close it with the session-preserving code, and schedule the
   * next connection. The close handler ignores abandoned sockets, so recovery
   * is triggered exactly once and never waits on a close event that a
   * half-dead socket may never fire.
   */
  private killAndRecover(
    ws: GatewaySocketLike,
    reason: string,
    minimumDelayMs = 0,
  ): void {
    if (this.ws === ws) {
      this.ws = null;
    }
    this.cancelHeartbeatTimer?.();
    this.cancelHeartbeatTimer = null;
    this.cancelHelloTimer?.();
    this.cancelHelloTimer = null;
    this.cancelStabilityTimer?.();
    this.cancelStabilityTimer = null;
    try {
      ws.close(RESUMABLE_CLOSE_CODE, reason);
    } catch {
      // The socket may already be broken — recovery proceeds regardless.
    }
    this.scheduleReconnect(minimumDelayMs);
  }

  /** A received close. The taxonomy decides what the session is still worth. */
  private handleClose(code: number | undefined): void {
    this.cancelHeartbeatTimer?.();
    this.cancelHeartbeatTimer = null;
    this.cancelHelloTimer?.();
    this.cancelHelloTimer = null;
    this.cancelStabilityTimer?.();
    this.cancelStabilityTimer = null;
    if (!this.running) {
      return;
    }

    const action = recoveryActionForCloseCode(code);
    if (isClientFaultCloseCode(code)) {
      log.error(
        { code },
        "Discord closed the connection over a payload this client sent — " +
          "recovering, but this is a bug worth a look",
      );
    }
    if (action === "fatal") {
      this.latched = true;
      this.running = false;
      log.error(
        { code },
        `Discord Gateway connection is fatally closed. ${
          fatalCloseDiagnostic(code) ?? ""
        }`.trim(),
      );
      return;
    }
    if (action === "identify") {
      this.sessionState?.invalidate();
    }
    log.info({ code, action }, "Discord Gateway disconnected — recovering");
    this.scheduleReconnect();
  }

  private scheduleReconnect(minimumDelayMs = 0): void {
    if (!this.running || this.latched || this.cancelReconnectTimer) {
      return;
    }
    const kind = this.sessionState?.canResume ? "resume" : "identify";
    const delayMs = Math.max(this.backoff.nextDelayMs(kind), minimumDelayMs);
    log.info({ kind, delayMs }, "Scheduling Discord Gateway reconnect");
    this.cancelReconnectTimer = this.schedule(() => {
      this.cancelReconnectTimer = null;
      if (this.sessionState) {
        this.openSocket();
      } else {
        void this.bootstrap();
      }
    }, delayMs);
  }

  private handleDispatch(eventType: string | undefined, data: unknown): void {
    switch (eventType) {
      case "READY": {
        const ready = DiscordReadySchema.safeParse(data);
        if (
          !ready.success ||
          !ready.data.session_id ||
          !ready.data.resume_gateway_url
        ) {
          log.error("Discord READY carried no usable session fields");
          return;
        }
        this.sessionState?.noteReady(
          ready.data.session_id,
          ready.data.resume_gateway_url,
        );
        if (ready.data.user?.id) {
          this.botUserId = ready.data.user.id;
        }
        log.info(
          { botUserId: this.botUserId },
          "Discord Gateway session established",
        );
        this.noteSessionEstablished();
        return;
      }
      case "RESUMED":
        log.info("Discord Gateway session resumed");
        this.noteSessionEstablished();
        return;
      case "GUILD_CREATE":
      case "THREAD_LIST_SYNC": {
        const list = DiscordThreadListSchema.safeParse(data);
        if (list.success) {
          this.threadParents.noteAll(list.data.threads);
        }
        return;
      }
      case "THREAD_CREATE":
      case "THREAD_UPDATE": {
        const thread = DiscordThreadSchema.safeParse(data);
        if (thread.success) {
          this.threadParents.note(thread.data);
        }
        return;
      }
      case "THREAD_DELETE": {
        const thread = DiscordThreadSchema.safeParse(data);
        if (thread.success) {
          this.threadParents.forget(thread.data.id);
        }
        return;
      }
      case "MESSAGE_CREATE":
        this.handleMessageCreate(data);
        return;
      case "MESSAGE_UPDATE":
        this.handleMessageUpdate(data);
        return;
      case "MESSAGE_DELETE":
        this.handleMessageDelete(data);
        return;
      case "MESSAGE_REACTION_ADD":
        this.handleMessageReaction(data, "added");
        return;
      case "MESSAGE_REACTION_REMOVE":
        this.handleMessageReaction(data, "removed");
        return;
      case "INTERACTION_CREATE":
        this.handleInteractionCreate(data);
        return;
      default:
        return;
    }
  }

  private handleMessageUpdate(data: unknown): void {
    if (!this.botUserId) {
      log.warn("Dropping MESSAGE_UPDATE: bot identity not yet resolved");
      return;
    }
    const parsed = DiscordMessageCreateSchema.safeParse(data);
    if (!parsed.success) {
      log.warn("Dropping malformed MESSAGE_UPDATE");
      return;
    }
    const message = parsed.data;
    // Embed resolution and other non-user revisions dispatch MESSAGE_UPDATE
    // with no edited_timestamp; nothing the user said changed, so there is
    // nothing to rewrite. Guild content is additionally ambiguous when
    // empty: without MESSAGE_CONTENT a non-exempt guild edit arrives with
    // its text hidden, and rewriting a stored row to empty would destroy
    // text over an intent gap. A DM is inside the content exemption, so an
    // empty DM revision is a real clearing (an attachment message whose
    // caption was removed) and propagates.
    if (
      message.edited_timestamp == null ||
      (message.guild_id !== undefined && message.content.length === 0)
    ) {
      log.debug(
        { messageId: message.id },
        "Dropping MESSAGE_UPDATE with no user revision",
      );
      return;
    }
    const parentChannelId = this.threadParents.parentOf(message.channel_id);
    const candidate = toAdmissionCandidate(message, parentChannelId);
    if (!candidate) {
      log.warn("Dropping MESSAGE_UPDATE with no author identity");
      return;
    }
    const legacyAllowedChannelIds = this.readLegacyAllowedChannelIds?.();
    const verdict = admitDiscordMessage(candidate, {
      botUserId: this.botUserId,
      ...(legacyAllowedChannelIds !== undefined
        ? { legacyAllowedChannelIds }
        : {}),
    });
    if (!verdict.admitted) {
      log.debug(
        { reason: verdict.reason, channelId: message.channel_id },
        "Discord edit dropped by admission gate",
      );
      return;
    }
    const normalized = normalizeDiscordMessage(message, {
      ...(parentChannelId !== undefined ? { parentChannelId } : {}),
      raw: (data ?? {}) as Record<string, unknown>,
      edit: { revision: message.edited_timestamp },
    });
    if (!normalized) {
      log.warn(
        { messageId: message.id },
        "Discord edit dropped by normalization",
      );
      return;
    }
    log.info(
      {
        messageId: message.id,
        conversationExternalId: normalized.message.conversationExternalId,
      },
      "Discord edit admitted",
    );
    this.onEvent(normalized, new Map());
  }

  private handleMessageDelete(data: unknown): void {
    const parsed = DiscordMessageDeleteSchema.safeParse(data);
    if (!parsed.success) {
      log.warn("Dropping malformed MESSAGE_DELETE");
      return;
    }
    const del = parsed.data;
    // No admission gate: the dispatch names no author to gate on, and the
    // daemon applies an unattributed delete only to a row it ingested, so a
    // delete for anything the admission gate kept out is a no-op there. The
    // event still rides the full forward path, where the kill switch and
    // per-family stages apply.
    const parentChannelId = this.threadParents.parentOf(del.channel_id);
    const normalized = normalizeDiscordMessageDelete(del, {
      ...(parentChannelId !== undefined ? { parentChannelId } : {}),
      raw: (data ?? {}) as Record<string, unknown>,
    });
    if (!normalized) {
      log.warn(
        { messageId: del.id },
        "Discord delete dropped by normalization",
      );
      return;
    }
    log.info(
      {
        messageId: del.id,
        conversationExternalId: normalized.message.conversationExternalId,
      },
      "Discord delete forwarded",
    );
    this.onEvent(normalized, new Map());
  }

  private handleInteractionCreate(data: unknown): void {
    const parsed = DiscordInteractionSchema.safeParse(data);
    if (!parsed.success) {
      log.warn("Dropping malformed INTERACTION_CREATE");
      return;
    }
    const interaction = parsed.data;
    // Only component button presses are consumed; commands, selects and
    // modals have no consumer, and an unhandled interaction type must not be
    // acked into a state the user reads as accepted.
    if (
      interaction.type !== DISCORD_INTERACTION_TYPE_MESSAGE_COMPONENT ||
      interaction.data?.component_type !== DISCORD_COMPONENT_TYPE_BUTTON
    ) {
      return;
    }
    if (!interaction.id || !interaction.token) {
      log.warn("Dropping INTERACTION_CREATE without id or token");
      return;
    }
    // ACK inside Discord's 3-second deadline, before any forwarding work.
    // DeferredMessageUpdate leaves the card untouched; the daemon's decision
    // flow rewrites it through the notification adapter's update path, the
    // same shape as Telegram's answerCallbackQuery-then-edit.
    void this.acknowledgeInteraction(interaction.id, interaction.token);
    const parentChannelId = interaction.channel_id
      ? this.threadParents.parentOf(interaction.channel_id)
      : undefined;
    const normalized = normalizeDiscordInteraction(interaction, {
      ...(parentChannelId !== undefined ? { parentChannelId } : {}),
      raw: (data ?? {}) as Record<string, unknown>,
    });
    if (!normalized) {
      log.debug(
        { interactionId: interaction.id },
        "Discord interaction dropped by normalization",
      );
      return;
    }
    log.info(
      {
        interactionId: interaction.id,
        conversationExternalId: normalized.message.conversationExternalId,
      },
      "Discord button press forwarded",
    );
    this.onEvent(normalized, new Map());
  }

  /**
   * POST the deferred-update ack for a component press. The interaction
   * token in the URL authorizes the call; no bot header is needed. Failure
   * is logged and swallowed: the press still forwards, and the only cost is
   * Discord showing the guardian an interaction-failed notice.
   */
  private async acknowledgeInteraction(
    interactionId: string,
    token: string,
  ): Promise<void> {
    try {
      const response = await this.fetchFn(
        `${DISCORD_API_BASE_URL}/interactions/${interactionId}/${token}/callback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: DISCORD_INTERACTION_CALLBACK_DEFERRED_UPDATE,
          }),
        },
      );
      if (!response.ok) {
        log.warn(
          { interactionId, status: response.status },
          "Discord interaction ack failed",
        );
      }
    } catch (err) {
      log.warn({ err, interactionId }, "Discord interaction ack failed");
    }
  }

  private handleMessageReaction(data: unknown, op: "added" | "removed"): void {
    // Fail-closed like MESSAGE_CREATE: without the bot's own id, reactions
    // the bot itself adds are indistinguishable from a person's.
    if (!this.botUserId) {
      log.warn("Dropping MESSAGE_REACTION: bot identity not yet resolved");
      return;
    }
    const parsed = DiscordMessageReactionSchema.safeParse(data);
    if (!parsed.success) {
      log.warn("Dropping malformed MESSAGE_REACTION");
      return;
    }
    const reaction = parsed.data;
    // The bot's own reactions are self-echoes, never signals to ingest.
    if (reaction.user_id === this.botUserId) {
      return;
    }
    // No admission gate: the daemon's reaction intercept drops a stranger's
    // reaction before any write and drops a reaction whose target message it
    // never stored, so anything the gate would exclude is a no-op there. The
    // event still rides the full forward path, where the kill switch and
    // per-family stages apply.
    const parentChannelId = this.threadParents.parentOf(reaction.channel_id);
    const normalized = normalizeDiscordMessageReaction(reaction, {
      op,
      ...(parentChannelId !== undefined ? { parentChannelId } : {}),
      raw: (data ?? {}) as Record<string, unknown>,
    });
    if (!normalized) {
      log.debug(
        { messageId: reaction.message_id },
        "Discord reaction dropped by normalization",
      );
      return;
    }
    log.info(
      {
        messageId: reaction.message_id,
        conversationExternalId: normalized.message.conversationExternalId,
        op,
      },
      "Discord reaction forwarded",
    );
    this.onEvent(normalized, new Map());
  }

  private handleMessageCreate(data: unknown): void {
    // Fail-closed: without the bot's own id, self-echoes and mentions are
    // indistinguishable. READY precedes dispatches on every socket, so this
    // only trips on a malformed READY.
    if (!this.botUserId) {
      log.warn("Dropping MESSAGE_CREATE: bot identity not yet resolved");
      return;
    }
    const parsed = DiscordMessageCreateSchema.safeParse(data);
    if (!parsed.success) {
      log.warn("Dropping malformed MESSAGE_CREATE");
      return;
    }
    const message = parsed.data;
    // Parent resolution serves the normalized event's conversation binding,
    // and, under a legacy allow-list, the thread-inheritance rule.
    const parentChannelId = this.threadParents.parentOf(message.channel_id);
    const candidate = toAdmissionCandidate(message, parentChannelId);
    if (!candidate) {
      log.warn("Dropping MESSAGE_CREATE with no author identity");
      return;
    }

    const legacyAllowedChannelIds = this.readLegacyAllowedChannelIds?.();
    const verdict = admitDiscordMessage(candidate, {
      botUserId: this.botUserId,
      ...(legacyAllowedChannelIds !== undefined
        ? { legacyAllowedChannelIds }
        : {}),
    });
    if (!verdict.admitted) {
      const fields = {
        reason: verdict.reason,
        channelId: message.channel_id,
        messageId: message.id,
      };
      // Severity splits by reason and volume is capped at the first drop per
      // reason and channel; see `admission-log.ts`.
      const level = this.admissionDropLog.levelFor(
        verdict.reason,
        message.channel_id,
      );
      if (level === "info") {
        log.info(
          fields,
          "Discord message dropped by admission gate. Further drops for " +
            "this reason and channel log at debug.",
        );
      } else {
        log.debug(fields, "Discord message dropped by admission gate");
      }
      return;
    }

    const normalized = normalizeDiscordMessage(message, {
      ...(parentChannelId !== undefined ? { parentChannelId } : {}),
      raw: (data ?? {}) as Record<string, unknown>,
    });
    if (!normalized) {
      log.warn(
        { messageId: message.id },
        "Discord message dropped by normalization",
      );
      return;
    }
    log.info(
      {
        messageId: message.id,
        conversationExternalId: normalized.message.conversationExternalId,
        inThread: normalized.source.threadId !== undefined,
      },
      "Discord message admitted",
    );
    this.onEvent(normalized, extractDiscordAttachmentMap(message.attachments));
  }

  /**
   * READY / RESUMED. The backoff clears only after the session holds — a
   * session that dies seconds after READY is exactly the flap the pacing
   * exists to survive.
   */
  private noteSessionEstablished(): void {
    this.cancelStabilityTimer?.();
    this.cancelStabilityTimer = this.schedule(() => {
      this.cancelStabilityTimer = null;
      this.backoff.noteSessionStable();
    }, SESSION_STABLE_AFTER_MS);
  }

  private cancelTimers(): void {
    this.cancelHeartbeatTimer?.();
    this.cancelHeartbeatTimer = null;
    this.cancelHelloTimer?.();
    this.cancelHelloTimer = null;
    this.cancelReconnectTimer?.();
    this.cancelReconnectTimer = null;
    this.cancelStabilityTimer?.();
    this.cancelStabilityTimer = null;
  }
}
