/**
 * Bot → daemon event publisher.
 *
 * Buffers `MeetBotEvent`s produced by the scrapers/lifecycle emitters and
 * ships them to the daemon's ingress endpoint
 * (`POST /v1/internal/meet/:meetingId/events`) in small batches. Batching
 * amortizes HTTP overhead without introducing perceptible delay — the flush
 * triggers on whichever comes first of:
 *
 *   - `MAX_BATCH_SIZE` queued events, or
 *   - `FLUSH_INTERVAL_MS` since the first unflushed enqueue.
 *
 * Transient network / 5xx failures are retried with exponential backoff
 * (3 attempts, 250/500/1000ms). A 4xx is treated as a caller bug and
 * surfaced to the `onError` hook without retrying — the daemon has
 * rejected the payload, so retransmitting the same bytes is pointless.
 *
 * The fetch implementation is injected so tests can assert on calls
 * without hitting the network. In production the default is `globalThis.fetch`.
 *
 * ## Wire shape
 *
 * The daemon's ingress route in PR 9 decodes the request body as
 * `MeetBotEvent[]` — a bare JSON array, not an object wrapper. We match
 * that shape here so the two sides stay interoperable.
 */

import type { MeetBotEvent } from "@vellumai/meet-contracts";

/** Default flush cadence and batch size — tuned in the PR description. */
const MAX_BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 250;

/**
 * Exponential backoff schedule for retrying transient failures.
 * Covers the three retry attempts (original + 3 retries = 4 total calls).
 */
const RETRY_BACKOFF_MS = [250, 500, 1000] as const;

/** Fetch signature the client calls through. `globalThis.fetch`-shaped. */
export type FetchFn = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface DaemonClientOptions {
  /**
   * Base URL of the daemon's HTTP server (no trailing slash). The final
   * URL the client POSTs to is
   * `${daemonUrl}/v1/internal/meet/${meetingId}/events`.
   */
  daemonUrl: string;
  /** Meeting identifier — segmented into the path. */
  meetingId: string;
  /** Bearer token the daemon verifies against its session registry. */
  botApiToken: string;
  /**
   * Injectable fetch. Defaults to `globalThis.fetch` bound to globalThis
   * so Node's fetch doesn't lose its receiver when called indirectly.
   */
  fetch?: FetchFn;
  /**
   * Called when a batch ultimately fails after exhausting retries or hits
   * an unretryable 4xx. Receives the error and the batch that failed so
   * callers can log / alert. If the callback throws it's swallowed to
   * keep the flush loop alive.
   */
  onError?: (err: Error, batch: MeetBotEvent[]) => void;
  /** Override batch size — tests use this to shrink or enlarge windows. */
  maxBatchSize?: number;
  /** Override flush cadence. */
  flushIntervalMs?: number;
}

/**
 * Batches and ships bot events to the daemon.
 *
 * Instance-per-meeting — the meeting id and bearer token are immutable for
 * the client's lifetime. Call `enqueue` to append events and `stop` to
 * drain pending events and tear down the flush timer.
 */
export class DaemonClient {
  private readonly url: string;
  private readonly authHeader: string;
  private readonly doFetch: FetchFn;
  private readonly onError?: (err: Error, batch: MeetBotEvent[]) => void;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;

  /**
   * Pending events waiting for the next flush. We never slice this in
   * place — a flush drains it fully and keeps a separate reference to
   * the batch being shipped so new enqueues during the POST don't get
   * mixed into the in-flight request.
   */
  private buffer: MeetBotEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /**
   * Chain of in-flight flushes. We serialize flushes so the daemon
   * sees events in enqueue order even when two timers race (e.g. a
   * manual `flush()` call overlaps the scheduled timer firing).
   */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(opts: DaemonClientOptions) {
    // Trim a trailing slash so `${url}/v1/...` doesn't double up.
    const base = opts.daemonUrl.replace(/\/+$/, "");
    this.url = `${base}/v1/internal/meet/${encodeURIComponent(opts.meetingId)}/events`;
    this.authHeader = `Bearer ${opts.botApiToken}`;
    this.doFetch =
      opts.fetch ??
      ((...args) =>
        (globalThis.fetch as unknown as FetchFn)(...args));
    this.onError = opts.onError;
    this.maxBatchSize = opts.maxBatchSize ?? MAX_BATCH_SIZE;
    this.flushIntervalMs = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  }

  /**
   * Append an event to the outgoing buffer. Schedules a flush at
   * `flushIntervalMs` after the first buffered event, or flushes
   * immediately once the buffer hits `maxBatchSize`.
   *
   * Enqueuing after `stop()` is a no-op — late DOM callbacks during
   * shutdown shouldn't resurrect the flush loop.
   */
  enqueue(event: MeetBotEvent): void {
    if (this.stopped) return;
    this.buffer.push(event);

    if (this.buffer.length >= this.maxBatchSize) {
      // Tip over into immediate flush. Drain the buffer *synchronously*
      // here so follow-on enqueues in the same tick start a fresh batch
      // rather than piggybacking onto the in-flight POST. Without this,
      // a caller emitting 25 events synchronously would ship all 25 in
      // one batch instead of splitting at 20.
      const batch = this.buffer;
      this.buffer = [];
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      void this.shipBatch(batch);
      return;
    }

    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.flushIntervalMs);
    }
  }

  /**
   * Drain the buffer and POST the events to the daemon. Returns once
   * the POST (and retries) have settled.
   *
   * Callers normally don't invoke this directly — the timer/batch-size
   * triggers handle it automatically. `stop()` calls `flush()` as its
   * last step so pending events aren't lost at teardown.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      // Nothing pending locally, but earlier enqueues may have scheduled
      // in-flight shipments — wait for them so callers observing
      // `flush()` resolution see a fully drained pipeline.
      await this.flushChain.catch(() => undefined);
      return;
    }
    const batch = this.buffer;
    this.buffer = [];
    await this.shipBatch(batch);
  }

  /**
   * Stop the client: clear any pending timer, flush whatever is still
   * buffered, and mark the instance as no-longer-enqueuing.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      // Even when already stopped, awaiting the chain ensures callers
      // observing `stop()` resolution see all prior flushes settled.
      await this.flushChain.catch(() => undefined);
      return;
    }
    this.stopped = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * POST a pre-captured batch (with retries). Errors are reported
   * through `onError` rather than thrown — the caller's call stack is
   * not involved for fire-and-forget flushes.
   */
  private async shipBatch(batch: MeetBotEvent[]): Promise<void> {
    // Serialize shipments so the daemon sees events in the same order
    // the scrapers produced them. Without this, a size-triggered
    // immediate flush could race a scheduled timer flush.
    const prior = this.flushChain;
    const next = prior.then(async () => {
      try {
        await this.postWithRetry(batch);
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        if (this.onError) {
          try {
            this.onError(wrapped, batch);
          } catch {
            // onError throwing is the caller's bug; keep the loop alive.
          }
        }
      }
    });
    this.flushChain = next.catch(() => undefined);
    await next;
  }

  /** POST with exponential backoff on retriable failures. */
  private async postWithRetry(batch: MeetBotEvent[]): Promise<void> {
    const body = JSON.stringify(batch);
    let lastErr: Error | null = null;

    // Four attempts: the initial try plus RETRY_BACKOFF_MS.length retries.
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
      let res: Awaited<ReturnType<FetchFn>>;
      try {
        res = await this.doFetch(this.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: this.authHeader,
          },
          body,
        });
      } catch (err) {
        // Network error: retriable.
        lastErr = err instanceof Error ? err : new Error(String(err));
        const backoff = RETRY_BACKOFF_MS[attempt];
        if (backoff === undefined) break;
        await sleep(backoff);
        continue;
      }

      if (res.ok) return;

      // 4xx is terminal — retrying the same bytes won't change the
      // outcome. 5xx (and any other non-ok) is retriable.
      if (res.status >= 400 && res.status < 500) {
        const bodyText = await res.text().catch(() => "");
        const detail = bodyText.length > 0 ? `: ${bodyText}` : "";
        throw new Error(
          `daemon-client: ingress rejected batch with status ${res.status}${detail}`,
        );
      }
      lastErr = new Error(
        `daemon-client: ingress returned status ${res.status}`,
      );

      const backoff = RETRY_BACKOFF_MS[attempt];
      if (backoff === undefined) break;
      await sleep(backoff);
    }

    throw (
      lastErr ??
      new Error("daemon-client: exhausted retries with no recorded error")
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
