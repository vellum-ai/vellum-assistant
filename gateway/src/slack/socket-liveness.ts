/**
 * Liveness for the Slack Socket Mode connection.
 *
 * Socket Mode carries no application-level heartbeat. The protocol delivers
 * an opening `hello`, workspace events, and a rotation `disconnect`, and
 * nothing else. A workspace can be legitimately silent for hours, so "no
 * frames lately" says nothing about whether the socket still works, and any
 * detector built on inbound quiet either misses real deaths or kills healthy
 * connections. The one signal that separates a quiet socket from a dead one
 * is the WebSocket layer's own ping/pong, and the only way to obtain that
 * signal on demand is to send a ping and require a pong back.
 *
 * So this probes. Every {@link DEFAULT_PROBE_INTERVAL_MS} it sends a ping
 * frame and arms a deadline; a pong disarms it, and a deadline that expires
 * means the connection is gone. Because the probe is generated locally,
 * detection latency is bounded by the probe cadence rather than by whatever
 * the workspace happens to be doing.
 *
 * This is deliberately not the Discord client's shape (`discord/heartbeat.ts`).
 * There, op 1 / op 11 is an application-protocol exchange the gateway must
 * perform anyway, so liveness rides on a beat that has to happen regardless.
 * Slack requires no such beat; the ping frame exists purely for this check,
 * and it lives at the transport layer rather than in the event stream.
 *
 * Timers are injectable, so the whole watchdog is testable without real time.
 */

import {
  defaultSchedule,
  type CancelTimer,
  type ScheduleFn,
} from "../util/schedule.js";

/** The slice of a socket this watchdog drives. */
export type LivenessSocket = {
  ping(): void;
};

/** Why the watchdog concluded the connection was dead. */
export type LivenessDeathReason =
  | "no pong within deadline"
  | "socket rejected the ping frame";

/**
 * How often to probe the socket with a ping frame.
 *
 * Slack's own Socket Mode SDK treats a gap of more than 30s between server
 * pings as grounds to drop the connection (`serverPingTimeout`), so 30s is
 * the keepalive cadence Slack's edge is already engineered around. Matching
 * it keeps our probe traffic the same order of magnitude as the keepalive
 * the connection carries anyway, rather than adding a second, faster clock.
 */
export const DEFAULT_PROBE_INTERVAL_MS = 30_000;

/**
 * How long a probe may go unanswered before the connection is declared dead.
 *
 * Slack's SDK gives a pong 5s (`clientPingTimeout`), which is a measurement
 * of their edge rather than a guess of ours. This doubles that, because the
 * gateway process is not a dedicated socket client: it runs synchronous
 * SQLite work and attachment downloads on the same event loop, and a stall
 * there delays the pong handler without saying anything about the socket.
 *
 * The extra 5s spends detection latency out of a worst case of one probe
 * interval plus one deadline, and buys a wide margin against calling a
 * healthy connection dead. That trade favours the margin: a false positive
 * costs a reconnect plus a full catch-up fan-out across every routed
 * channel, while the latency it saves is invisible next to the multi-hour
 * outages this exists to prevent.
 */
export const DEFAULT_PONG_DEADLINE_MS = 10_000;

export type SlackSocketLivenessOptions = {
  /**
   * Called once when the connection is judged dead. The watchdog has already
   * stopped itself by then, so the handler is free to tear down and restart.
   */
  onDead: (reason: LivenessDeathReason) => void;
  /** Called with each measured ping/pong round trip, for observability. */
  onRoundTrip?: (roundTripMs: number) => void;
  schedule?: ScheduleFn;
  now?: () => number;
  probeIntervalMs?: number;
  pongDeadlineMs?: number;
};

export class SlackSocketLiveness {
  private readonly schedule: ScheduleFn;
  private readonly now: () => number;
  private readonly probeIntervalMs: number;
  private readonly pongDeadlineMs: number;

  private socket: LivenessSocket | null = null;
  private cancelProbeTimer: CancelTimer | null = null;
  private cancelDeadlineTimer: CancelTimer | null = null;
  private probeSentAt: number | undefined;
  private lastPongTimestamp: number | undefined;

  constructor(private readonly options: SlackSocketLivenessOptions) {
    this.schedule = options.schedule ?? defaultSchedule;
    this.now = options.now ?? Date.now;
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.pongDeadlineMs = options.pongDeadlineMs ?? DEFAULT_PONG_DEADLINE_MS;
  }

  /**
   * Begin probing `socket`. Safe to call on a watchdog that is already
   * running: the previous socket's timers are dropped first, so a reconnect
   * cannot leave a stale probe pointed at a dead generation.
   */
  start(socket: LivenessSocket): void {
    this.stop();
    this.socket = socket;
    this.armProbe();
  }

  /**
   * Record an inbound pong, clearing the outstanding probe deadline.
   *
   * A pong that cannot be matched to an outstanding probe still clears the
   * deadline. Slack answers one pong per ping, so the ambiguous case is
   * vanishingly rare, and resolving it toward "alive" is the safe direction:
   * a genuinely dead socket produces no pongs at all, so no amount of
   * mismatching can keep this watchdog from firing on one.
   */
  notePong(): void {
    this.lastPongTimestamp = this.now();
    if (this.probeSentAt !== undefined) {
      this.options.onRoundTrip?.(this.now() - this.probeSentAt);
      this.probeSentAt = undefined;
    }
    this.cancelDeadlineTimer?.();
    this.cancelDeadlineTimer = null;
  }

  /**
   * When this socket last proved it was alive, or undefined if it has not yet.
   *
   * Describes the current generation only, so a fresh connection reports
   * undefined until its first probe is answered rather than inheriting the
   * previous socket's answer. Readers must therefore treat absence as "not
   * proven yet", never as "proven dead": the first probe is a full interval
   * away, so every reconnect has a window where this is legitimately empty.
   */
  get lastPongAt(): number | undefined {
    return this.lastPongTimestamp;
  }

  /** Drop all timers and forget the socket. Idempotent. */
  stop(): void {
    this.cancelProbeTimer?.();
    this.cancelProbeTimer = null;
    this.cancelDeadlineTimer?.();
    this.cancelDeadlineTimer = null;
    this.probeSentAt = undefined;
    this.lastPongTimestamp = undefined;
    this.socket = null;
  }

  private armProbe(): void {
    this.cancelProbeTimer = this.schedule(() => {
      this.cancelProbeTimer = null;
      const socket = this.socket;
      if (!socket) {
        return;
      }

      try {
        socket.ping();
      } catch {
        // A socket that will not accept a ping frame is already gone; there
        // is nothing left to wait for.
        this.fireDead("socket rejected the ping frame");
        return;
      }

      this.probeSentAt = this.now();
      this.armDeadline();
      this.armProbe();
    }, this.probeIntervalMs);
  }

  private armDeadline(): void {
    this.cancelDeadlineTimer?.();
    this.cancelDeadlineTimer = this.schedule(() => {
      this.cancelDeadlineTimer = null;
      this.fireDead("no pong within deadline");
    }, this.pongDeadlineMs);
  }

  private fireDead(reason: LivenessDeathReason): void {
    // Stop before notifying so the handler can start a fresh generation
    // without racing this one's timers.
    this.stop();
    this.options.onDead(reason);
  }
}
