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
  /**
   * The plaintext the route actually served for this success. Retained so the
   * persist seams redact the EXACT bytes the tool printed, rather than a later
   * vault read that a rotation/deletion between reveal and persist could make
   * diverge (or empty). This is the same secret the model already received in
   * the tool result — holding it in the process-local, count-and-age-bounded
   * registry for the length of one turn adds no new exposure surface.
   */
  readonly value: string;
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
 * ground truth the promotion check trusts. `value` is the plaintext the
 * route served, retained so persist redacts the exact printed bytes.
 */
export function recordRevealSuccess(
  service: string,
  field: string,
  value: string,
): void {
  const nowMs = Date.now();
  seqCounter += 1;
  records.push({ seq: seqCounter, service, field, value, recordedAtMs: nowMs });
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
  return revealedValueSince(watermark, service, field) !== undefined;
}

/**
 * The plaintext the reveal route served for `service`/`field` after
 * `watermark`, or `undefined` if no matching success was recorded. When
 * several successes match (a value re-revealed within the window), the most
 * recent wins — it reflects what the latest reveal actually printed. Callers
 * use this to redact the exact served bytes instead of re-reading the vault,
 * which a rotation/deletion between reveal and persist could make diverge.
 */
export function revealedValueSince(
  watermark: number,
  service: string,
  field: string,
): string | undefined {
  const nowMs = Date.now();
  let best: RevealSuccessRecord | undefined;
  for (const r of records) {
    if (
      r.seq > watermark &&
      r.service === service &&
      r.field === field &&
      nowMs - r.recordedAtMs <= MAX_AGE_MS &&
      (best === undefined || r.seq > best.seq)
    ) {
      best = r;
    }
  }
  return best?.value;
}

/** Test-only: clear all records and reset the watermark counter. */
export function _resetRevealSuccessRegistryForTest(): void {
  seqCounter = 0;
  records = [];
}
