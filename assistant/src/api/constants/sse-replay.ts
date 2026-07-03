/**
 * Maximum number of events the daemon's per-process SSE replay ring
 * retains for `Last-Event-ID` resume. This is the ring's count bound; the
 * ring is also bounded by total bytes and entry age (whichever limit is
 * hit first wins), so the live ring can hold *fewer* than this many
 * events, never more. The daemon-side definition and eviction live in
 * `assistant/src/runtime/assistant-stream-state.ts`.
 *
 * Exposed on the API surface so the web client's SSE consumer can size
 * its seq-gap tolerance against the same number the daemon buffers
 * against, instead of hard-coding a duplicate.
 *
 * A live seq gap smaller than this is benign: the global per-assistant
 * `seq` counter is stamped before fanout, but the hub deliberately
 * withholds some events from a given subscriber — self-echo-suppressed
 * `sync_changed` (a client's own mutation echo) and capability-targeted
 * host-proxy events — so a subscriber legitimately sees its cursor skip a
 * few seqs it was never going to receive. Such a hole is not data loss
 * and must not trigger a destructive authoritative snapshot heal. Only a
 * gap that meets or exceeds this count proves the live suffix fell
 * outside the ring entirely and is genuinely non-contiguous.
 */
export const SSE_REPLAY_RING_COUNT_LIMIT = 200;

/**
 * Maximum age (in milliseconds) an event may reach in the daemon's SSE
 * replay ring before it is evicted, regardless of count or byte usage.
 * The daemon-side definition and eviction live in
 * `assistant/src/runtime/assistant-stream-state.ts`.
 *
 * Exposed alongside the count bound so the web client can reason about
 * the age dimension of the ring too. A small live seq gap is only safe to
 * treat as benign when the client has been continuously receiving events
 * — live delivery is concurrent with stamping, so a connected subscriber
 * never relies on the ring. Once the connection has been quiet for longer
 * than this window (a disconnect/resume), events the client missed may
 * have aged out of the ring and become unrecoverable by replay, so even a
 * small seq gap must trigger an authoritative reconcile rather than be
 * waved through.
 */
export const SSE_REPLAY_RING_AGE_LIMIT_MS = 30_000;
