/**
 * In-process registry of successful `credentials_reveal` route executions.
 *
 * The chat-credential-reveal persist seams need PROOF that a reveal
 * actually ran before candidate resolution may read a plaintext from the
 * store: a shell tool's overall success is not that proof (`assistant
 * credentials reveal … || true` succeeds when the route failed, and an
 * `echo` containing the command text never calls the route at all). The
 * reveal route handler is the single place plaintext legitimately leaves
 * the store for a reveal, so it records each success here and the agent
 * loop promotes staged candidate refs only when a matching identity was
 * recorded between the tool's proposal and its result.
 *
 * Watermarks are a monotonic sequence counter: callers capture the
 * watermark when a tool_use stages refs and query "did identity X succeed
 * since?" at result time — records from earlier turns or long-dead tools
 * never match. The registry is process-local (route handlers and the
 * conversation loop share the daemon process) and bounded by count and
 * age so it cannot grow without limit.
 *
 * Known limitation (shared with the --for-chat mint registry and tracked
 * as its follow-up): records are not conversation-scoped, so a concurrent
 * conversation's successful reveal of the SAME identity inside the
 * propose→result window would also satisfy the check. Deriving a trusted
 * tool-subprocess→conversation mapping daemon-side closes that gap for
 * both registries at once.
 */

interface RevealSuccessRecord {
  readonly seq: number;
  readonly service: string;
  readonly field: string;
  readonly recordedAtMs: number;
}

const MAX_RECORDS = 256;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

let seqCounter = 0;
let records: RevealSuccessRecord[] = [];

function prune(nowMs: number): void {
  records = records.filter((r) => nowMs - r.recordedAtMs <= MAX_AGE_MS);
  if (records.length > MAX_RECORDS) {
    records = records.slice(records.length - MAX_RECORDS);
  }
}

/**
 * Current watermark. Capture BEFORE the reveal tool executes; only
 * successes recorded after this point satisfy {@link hasRevealSuccessSince}.
 */
export function currentRevealSuccessWatermark(): number {
  return seqCounter;
}

/**
 * Record a successful reveal. Call ONLY from the `credentials_reveal`
 * route handler, after the plaintext has been located — this is the
 * ground truth the promotion check trusts.
 */
export function recordRevealSuccess(service: string, field: string): void {
  const nowMs = Date.now();
  seqCounter += 1;
  records.push({ seq: seqCounter, service, field, recordedAtMs: nowMs });
  prune(nowMs);
}

/**
 * Whether the reveal route succeeded for `service`/`field` after
 * `watermark` was captured.
 */
export function hasRevealSuccessSince(
  watermark: number,
  service: string,
  field: string,
): boolean {
  const nowMs = Date.now();
  return records.some(
    (r) =>
      r.seq > watermark &&
      r.service === service &&
      r.field === field &&
      nowMs - r.recordedAtMs <= MAX_AGE_MS,
  );
}

/** Test-only: clear all records and reset the watermark counter. */
export function _resetRevealSuccessRegistryForTest(): void {
  seqCounter = 0;
  records = [];
}
