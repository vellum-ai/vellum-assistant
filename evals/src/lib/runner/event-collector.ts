import type { AgentEvent } from "../adapter";

const TIMEOUT = Symbol("timeout");

type PendingNext = Promise<IteratorResult<AgentEvent>>;

function timeout(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), ms));
}

export class AgentEventCollector {
  private pending?: PendingNext;

  constructor(private readonly iterator: AsyncIterator<AgentEvent>) {}

  private next(): PendingNext {
    this.pending ??= this.iterator.next();
    return this.pending;
  }

  /**
   * Drain events until the stream ends, the stream goes quiet for
   * `quietMs`, or the `maxMs` hard cap elapses — whichever comes first.
   * Each event resets the quiet timer, so an actively-streaming turn runs
   * up to `maxMs`. Shared by both public collectors.
   */
  private async drain(input: {
    quietMs: number;
    maxMs: number;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
  }): Promise<AgentEvent[]> {
    const { quietMs, maxMs, onEvent } = input;
    const events: AgentEvent[] = [];
    const hardDeadline = Date.now() + maxMs;
    let quietDeadline = Date.now() + quietMs;

    while (Date.now() < hardDeadline) {
      const waitMs = Math.max(
        0,
        Math.min(quietDeadline, hardDeadline) - Date.now(),
      );
      if (waitMs === 0) break;

      const result = await Promise.race([this.next(), timeout(waitMs)]);
      if (result === TIMEOUT) break;

      this.pending = undefined;
      if (result.done) break;

      events.push(result.value);
      // Let the caller react to the event (e.g. approve a pending tool
      // confirmation) before resetting the quiet timer, so the reaction's
      // latency doesn't count against the quiet window — and so the next
      // event, which the daemon only emits once the reaction unblocks the
      // turn, still gets a full window to arrive.
      if (onEvent) await onEvent(result.value);
      quietDeadline = Date.now() + quietMs;
    }

    return events;
  }

  async collectUntilQuiet(input: {
    quietMs: number;
    maxMs?: number;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
  }): Promise<AgentEvent[]> {
    const quietMs = input.quietMs;
    const maxMs = input.maxMs ?? Math.max(quietMs * 6, quietMs);
    return this.drain({ quietMs, maxMs, onEvent: input.onEvent });
  }

  /**
   * Like `collectUntilQuiet`, but reports whether the turn completed via
   * an explicit completion signal rather than treating "events stopped
   * arriving" as success.
   *
   * The turn is still drained to quiet (or `maxMs`) so trailing events
   * that arrive *after* the agent's completion line — e.g. the
   * `assistant_usage` / `message_complete` events the daemon emits at the
   * end of a turn — are captured for cost accounting. We do not stop the
   * instant the sentinel appears.
   *
   * `isDone` is evaluated against the full captured event list once the
   * drain settles, keeping content semantics (what counts as the
   * sentinel) out of the collector. A `false` result means the turn went
   * quiet or hit the hard cap without ever signalling completion (a
   * truncated or stalled ingest), letting the caller fail loudly instead
   * of grading it.
   */
  async collectUntilSentinel(input: {
    isDone: (events: readonly AgentEvent[]) => boolean;
    maxMs: number;
    quietMs: number;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
  }): Promise<{ events: AgentEvent[]; sentinelSeen: boolean }> {
    const events = await this.drain({
      quietMs: input.quietMs,
      maxMs: input.maxMs,
      onEvent: input.onEvent,
    });
    return { events, sentinelSeen: input.isDone(events) };
  }

  /**
   * Drain events until one satisfies `isComplete` — the adapter's
   * turn-completion signal (e.g. the Vellum daemon's `message_complete`)
   * — then drain trailing events (usage records, sync notifications)
   * with a short `graceQuietMs` quiet window before returning.
   *
   * Unlike `collectUntilQuiet` there is **no quiet window before the
   * completion event**: a turn that sits silent for a long pre-loop
   * phase (memory retrieval, embedding, first-token latency) is still
   * in flight, and only the `maxMs` hard cap — the caller's remaining
   * wall-clock budget for the run — bounds the wait. `completed: false`
   * means the stream ended or the cap elapsed without the turn ever
   * signalling completion; callers should fail loudly rather than
   * grading a truncated turn.
   */
  async collectUntilTurnComplete(input: {
    isComplete: (event: AgentEvent) => boolean;
    maxMs: number;
    graceQuietMs: number;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
  }): Promise<{ events: AgentEvent[]; completed: boolean }> {
    const hardDeadline = Date.now() + input.maxMs;
    const events: AgentEvent[] = [];
    let completed = false;

    while (!completed) {
      const waitMs = hardDeadline - Date.now();
      if (waitMs <= 0) return { events, completed };

      const result = await Promise.race([this.next(), timeout(waitMs)]);
      if (result === TIMEOUT) return { events, completed };

      this.pending = undefined;
      if (result.done) return { events, completed };

      events.push(result.value);
      if (input.onEvent) await input.onEvent(result.value);
      if (input.isComplete(result.value)) completed = true;
    }

    const trailing = await this.drain({
      quietMs: input.graceQuietMs,
      maxMs: Math.max(0, hardDeadline - Date.now()),
      onEvent: input.onEvent,
    });
    events.push(...trailing);
    return { events, completed };
  }
}
