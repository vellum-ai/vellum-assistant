/**
 * Heartbeat liveness for the Discord Gateway connection.
 *
 * Discord sends `heartbeat_interval` in op 10 HELLO; the client sends op 1 on
 * that interval and expects op 11 HEARTBEAT_ACK back. A missing ACK is the
 * documented signal that the connection is a zombie — open at the socket layer,
 * dead in fact — and the required response is to close with a non-1000 code and
 * resume.
 *
 * A second detector covers the case the ACK watchdog is slow at: a laptop
 * waking from sleep. The socket usually reports open, no close event ever
 * fires, and the session may already have timed out server-side. Timers,
 * however, fire late — so a heartbeat tick that arrives far past its interval
 * is evidence the process was suspended, and the connection should be treated
 * as dead without waiting a full interval to confirm it. That converts most of
 * a minute of post-wake deafness into near-immediate recovery.
 *
 * This module is the decision logic only: it owns no timers and no socket, so
 * it can be tested without waiting in real time.
 */

/**
 * How far past its due time a heartbeat tick must arrive to read as a suspend
 * rather than ordinary scheduling lag.
 *
 * Event-loop congestion routinely delays a timer by a noticeable fraction of
 * its interval; a process resuming from sleep overshoots by orders of
 * magnitude. Double the interval sits well clear of the first and well under
 * the second, so a false positive costs one resume — cheap, since resumes do
 * not touch the identify budget — while a false negative costs a full interval
 * of silently dropped messages.
 */
export const CLOCK_JUMP_FACTOR = 2;

export class HeartbeatMonitor {
  private intervalMs: number | undefined;
  private awaitingAck = false;
  private lastBeatAt: number | undefined;
  private lastAckTimestamp: number | undefined;

  /** `random` and `now` are injectable so tests can pin jitter and time. */
  constructor(
    private readonly random: () => number = Math.random,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record the interval from op 10 HELLO and return the delay before the first
   * beat.
   *
   * The first beat is jittered across the whole interval — Discord's docs
   * require it, so that every client reconnecting after a Gateway-side restart
   * does not beat in lockstep.
   */
  noteHello(intervalMs: number): number {
    this.intervalMs = intervalMs;
    this.awaitingAck = false;
    this.lastBeatAt = undefined;
    return Math.round(this.random() * intervalMs);
  }

  /** The steady-state interval, or undefined before HELLO. */
  get heartbeatIntervalMs(): number | undefined {
    return this.intervalMs;
  }

  /** Whether a beat is outstanding — true means the last op 1 has no op 11 yet. */
  get isAwaitingAck(): boolean {
    return this.awaitingAck;
  }

  /**
   * Whether the connection is a zombie and must be closed.
   *
   * True when the previous beat never got its ACK. Checked immediately before
   * sending the next beat, so a dead connection is caught within one interval
   * rather than accumulating unacknowledged beats.
   */
  isZombie(): boolean {
    return this.awaitingAck;
  }

  /**
   * Whether the gap since the last beat indicates the process was suspended.
   *
   * Returns false before the first beat and before HELLO, when there is no
   * interval to measure against.
   */
  detectedClockJump(): boolean {
    if (this.intervalMs === undefined || this.lastBeatAt === undefined) {
      return false;
    }
    const elapsed = this.now() - this.lastBeatAt;
    return elapsed > this.intervalMs * CLOCK_JUMP_FACTOR;
  }

  /** Record that op 1 was sent, opening the ACK window. */
  noteBeatSent(): void {
    this.awaitingAck = true;
    this.lastBeatAt = this.now();
  }

  /** Record op 11 HEARTBEAT_ACK, closing the ACK window. */
  noteAck(): void {
    this.awaitingAck = false;
    this.lastAckTimestamp = this.now();
  }

  /**
   * When this connection last proved it was alive, or undefined if it has not
   * yet. Discord's proof is an op 11 ACK, where a transport-level client's
   * would be a pong; the meaning is the same and so is the caveat, that a
   * connection which has not yet completed a beat is unproven rather than
   * dead.
   */
  get lastAckAt(): number | undefined {
    return this.lastAckTimestamp;
  }

  /**
   * Clear all state for a new connection.
   *
   * A reconnect that inherited a pending ACK from the previous socket would
   * declare the fresh connection a zombie on its first beat.
   */
  reset(): void {
    this.intervalMs = undefined;
    this.awaitingAck = false;
    this.lastBeatAt = undefined;
    this.lastAckTimestamp = undefined;
  }
}
