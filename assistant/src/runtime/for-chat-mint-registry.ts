/**
 * for-chat-mint-registry — daemon-side record of `--for-chat` reveals that
 * actually executed.
 *
 * The chat-credential-reveal persist guard re-mints sentinel-shaped spans
 * whose `service:field` identity matches a `--for-chat` reveal from the
 * current turn (see `guardForChatSentinels`). The authority for "a
 * `--for-chat` reveal happened" must be the reveal ROUTE itself — the one
 * place that enforces the feature flag and proves the credential exists —
 * never a string parse of the requested shell command: a segment that
 * merely quotes or comments out a reveal invocation (`echo 'assistant
 * credentials reveal --for-chat …'`) would otherwise allowlist an identity
 * for re-minting without the route ever running, letting forged sentinels
 * survive persistence.
 *
 * So: `handleCredentialsReveal` records every successful `--for-chat` mint
 * here (identity + the exact canonical sentinel it returned), and the
 * conversation loop asks for mints recorded since its turn started. The
 * stored sentinel doubles as the re-mint replacement — no vault re-read,
 * and a tampered type label can't survive because the replacement is the
 * daemon's own original mint.
 *
 * Scope: per conversation, per turn. `credentials reveal` is a high-risk
 * command (gateway approval gate), so an approval granted in one
 * conversation must not let a CONCURRENT conversation's model re-mint the
 * same identity without its own executed-and-approved reveal — mints are
 * therefore recorded with the originating conversation id (forwarded by
 * the CLI from the shell tool's `__CONVERSATION_ID` env) and reads filter
 * on it. A reveal executed outside any conversation records nothing: there
 * is no chat transcript for a chip to live in.
 */

/** A successful `--for-chat` reveal: identity plus the minted sentinel. */
export interface ForChatMint {
  service: string;
  field: string;
  /** The canonical sentinel the reveal route returned for this credential. */
  sentinel: string;
  /**
   * The conversation whose reveal command produced this mint (from the
   * `__CONVERSATION_ID` env the shell tool sets, forwarded by the CLI).
   * Re-minting is scoped to this conversation only.
   */
  conversationId: string;
}

interface MintRecord extends ForChatMint {
  seq: number;
  atMs: number;
}

/**
 * Retention guards. Records are tiny (one short sentinel string each), so
 * the bounds exist only to keep a pathological reveal loop from growing the
 * array unboundedly. The age bound comfortably outlives any single turn —
 * a watermark from a turn older than this has long since been superseded.
 */
const MAX_RECORDS = 256;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

let counter = 0;
let records: MintRecord[] = [];

/**
 * Watermark for "now". A turn captures this at start; mints recorded after
 * the capture are the ones `forChatMintsSince` returns for that turn.
 */
export function currentForChatMintWatermark(): number {
  return counter;
}

/** Record a successful `--for-chat` reveal. Called by the reveal route. */
export function recordForChatMint(mint: ForChatMint): void {
  counter += 1;
  records.push({ ...mint, seq: counter, atMs: Date.now() });
  const cutoff = Date.now() - MAX_AGE_MS;
  if (records.length > MAX_RECORDS || records[0]!.atMs < cutoff) {
    records = records.filter((r) => r.atMs >= cutoff).slice(-MAX_RECORDS);
  }
}

/**
 * Mints recorded after `watermark` for `conversationId`, deduplicated by
 * identity (latest wins — re-revealing the same credential re-mints the
 * same canonical sentinel). Mints from other conversations are never
 * returned: each conversation's re-mint allowlist is earned by its own
 * executed reveal.
 */
export function forChatMintsSince(
  watermark: number,
  conversationId: string,
): ForChatMint[] {
  const byIdentity = new Map<string, ForChatMint>();
  for (const r of records) {
    if (r.seq > watermark && r.conversationId === conversationId) {
      byIdentity.set(`${r.service}\u0000${r.field}`, {
        service: r.service,
        field: r.field,
        sentinel: r.sentinel,
        conversationId: r.conversationId,
      });
    }
  }
  return [...byIdentity.values()];
}

/** Test-only: drop all records and reset the watermark counter. */
export function resetForChatMintRegistryForTest(): void {
  counter = 0;
  records = [];
}
