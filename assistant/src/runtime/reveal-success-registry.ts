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
 * age so it cannot grow without limit (recent records get a short grace
 * from the count cap so an active tool window cannot lose its proof).
 *
 * Only DIRECT local-principal reveals record here (the unix-socket IPC
 * identity a tool shell's CLI invocation carries — see the route handler's
 * gate): a web or gateway-proxied reveal (Settings row, chat chips) is not
 * evidence any tool ran a reveal and must never become proof — including
 * local-mode web calls, where the gateway derives the `local` principal
 * from the JWT but always stamps `x-vellum-proxy-server: ipc`.
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
/**
 * Records younger than this are exempt from the count cap: a success may
 * still be inside an active propose→result window (a single command with
 * hundreds of reveal invocations, or concurrent turns), and count-evicting
 * it would silently drop the proof — the tool's stdout then persists raw.
 * Memory stays bounded: the age prune always applies, and the count cap
 * resumes for anything older than the grace period.
 */
const COUNT_PRUNE_GRACE_MS = 15 * 60 * 1000;

let seqCounter = 0;
let records: RevealSuccessRecord[] = [];

function prune(nowMs: number): void {
  records = records.filter((r) => nowMs - r.recordedAtMs <= MAX_AGE_MS);
  let excess = records.length - MAX_RECORDS;
  if (excess > 0) {
    // Oldest-first eviction (records are in seq order), skipping anything
    // still inside the grace window.
    records = records.filter((r) => {
      if (excess > 0 && nowMs - r.recordedAtMs > COUNT_PRUNE_GRACE_MS) {
        excess -= 1;
        return false;
      }
      return true;
    });
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
 * route handler, after the plaintext has been located AND the caller was
 * verified as the `local` principal (a tool shell's direct-IPC CLI call) —
 * this is the ground truth the promotion check trusts. `value` is the
 * plaintext the route served, retained so persist redacts the exact
 * printed bytes.
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
 * The most recent plaintext the reveal route served for `service`/`field`
 * after `watermark`, or `undefined` if no matching success was recorded.
 */
export function revealedValueSince(
  watermark: number,
  service: string,
  field: string,
): string | undefined {
  return revealedValuesSince(watermark, service, field)[0];
}

/**
 * ALL distinct plaintexts the reveal route served for `service`/`field`
 * after `watermark`, most recent first. Usually a single value, but a
 * rotate-and-re-reveal inside one window (reveal v1 → `credentials set` →
 * reveal v2) legitimately serves two different plaintexts — both were
 * printed to a tool's stdout, so persist redaction must treat each as a
 * candidate; surfacing only the latest would leave the earlier bytes
 * unprotected. Callers use these to redact the exact served bytes instead
 * of re-reading the vault, which a rotation/deletion between reveal and
 * persist could make diverge.
 */
export function revealedValuesSince(
  watermark: number,
  service: string,
  field: string,
): string[] {
  const nowMs = Date.now();
  const matches = records
    .filter(
      (r) =>
        r.seq > watermark &&
        r.service === service &&
        r.field === field &&
        nowMs - r.recordedAtMs <= MAX_AGE_MS,
    )
    .sort((a, b) => b.seq - a.seq);
  const seen = new Set<string>();
  const values: string[] = [];
  for (const r of matches) {
    if (!seen.has(r.value)) {
      seen.add(r.value);
      values.push(r.value);
    }
  }
  return values;
}

/** Test-only: clear all records and reset the watermark counter. */
export function _resetRevealSuccessRegistryForTest(): void {
  seqCounter = 0;
  records = [];
}
