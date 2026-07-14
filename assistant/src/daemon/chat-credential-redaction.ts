/**
 * Chat-persist credential redaction — sentinel markers with proven vault
 * identity (LUM-2768).
 *
 * The legacy persist path replaces detected secrets with a dead
 * `<redacted type="…" />` HTML marker that the chat markdown pipeline (no
 * rehype-raw) can never render as an element, and that carries no way back
 * to the vault entry it came from. This module implements the replacement
 * behavior behind the `chat-credential-reveal` feature flag:
 *
 *   1. While a turn runs, every shell-style tool command is scanned for
 *      `credentials reveal` invocations and the referenced credentials
 *      (`--service`/`--field` flags or a positional UUID) are recorded as
 *      *candidates* ({@link collectRevealRefsFromCommand}).
 *   2. At persist time, only those candidates' plaintexts are fetched from
 *      the credential store — a scoped read of secrets that were already in
 *      daemon memory this turn via the reveal stdout, never a vault scan
 *      ({@link resolveRevealCandidates}).
 *   3. Each redacted span in persisted ASSISTANT TEXT is byte-compared
 *      against the candidate values (tool_result content keeps the legacy
 *      marker until the tool detail panel can render chips — see
 *      `buildToolResultBlocks`).
 *      An exact match *proves* the span is that credential, so the sentinel
 *      is enriched with `service:field` and the client can offer
 *      click-to-reveal. Anything else — hand-typed secrets, parse failures,
 *      value drift — degrades to a plain type-only sentinel that renders as
 *      a static badge ({@link redactSecretsForChat}).
 *
 * Failure direction is the design's spine: a wrong `service:field` would let
 * the client reveal the *wrong* secret, so enrichment only ever happens on
 * exact plaintext equality. Every uncertain path fails toward "badge",
 * never toward "mislabeled chip".
 *
 * The legacy marker path (`redactSecrets`) is untouched — ingress blocking,
 * tool-output scanning, and log redaction depend on its exact shape (see
 * `security/AGENTS.md`). This module is additive and chat-persist-only.
 */

import {
  buildRedactedSentinel,
  neutralizeRedactedSentinels,
  REDACTED_SENTINEL_OPEN,
  REDACTED_SENTINEL_TAG,
} from "@vellumai/service-contracts/redacted-credential";

import { credentialKey } from "../security/credential-key.js";
import { redactSecretsWith } from "../security/secret-scanner.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getCredentialMetadataById } from "../tools/credentials/metadata-store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("chat-credential-redaction");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A credential reference parsed from a `credentials reveal` invocation. */
export interface RevealCandidateRef {
  service?: string;
  field?: string;
  /** Opaque credential UUID (positional CLI arg) — resolved to service/field. */
  id?: string;
}

/** A candidate with its plaintext, ready for byte-comparison. */
export interface ResolvedRevealCandidate {
  service: string;
  field: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/** Matches `credentials reveal` with any CLI entry point (`assistant`, bin
 *  paths, …) — the two words are what identify the subcommand. */
const REVEAL_INVOCATION_RE = /\bcredentials\s+reveal\b/;

const FLAG_VALUE = String.raw`(?:"([^"]*)"|'([^']*)'|([^\s"']+))`;
const SERVICE_FLAG_RE = new RegExp(String.raw`--service(?:=|\s+)${FLAG_VALUE}`);
const FIELD_FLAG_RE = new RegExp(String.raw`--field(?:=|\s+)${FLAG_VALUE}`);
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function flagValue(segment: string, re: RegExp): string | undefined {
  const m = re.exec(segment);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3];
}

/**
 * Extract credential refs from a shell command that may contain one or more
 * `credentials reveal` invocations (compound commands split on shell
 * separators). Returns an empty array for commands that never touch reveal —
 * the hot-path cost is one substring check.
 *
 * The parse is deliberately conservative: it recognizes the documented CLI
 * shapes (`--service X --field Y`, `--service=X`, quoted values, positional
 * UUID) and nothing else. An unparseable invocation yields no ref, which
 * downstream means no candidate and a plain (non-revealable) sentinel —
 * the safe direction.
 */
export function collectRevealRefsFromCommand(
  command: string,
): RevealCandidateRef[] {
  if (!command.includes("reveal")) return [];
  const refs: RevealCandidateRef[] = [];
  // Split compound commands so flags from one invocation can't bleed into
  // another (`reveal --service a --field b && reveal --service c --field d`).
  const segments = command.split(/(?:&&|\|\||[;|\n])/);
  for (const segment of segments) {
    if (!REVEAL_INVOCATION_RE.test(segment)) continue;
    const service = flagValue(segment, SERVICE_FLAG_RE);
    const field = flagValue(segment, FIELD_FLAG_RE);
    if (service !== undefined && field !== undefined) {
      refs.push({ service, field });
      continue;
    }
    const id = UUID_RE.exec(segment)?.[0];
    if (id) {
      refs.push({ id });
    }
    // No parseable identity → no ref. The span still gets redacted at
    // persist; it just won't be revealable.
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Candidate resolution (scoped store read)
// ---------------------------------------------------------------------------

/**
 * Resolve parsed refs to `{service, field, value}` candidates via scoped
 * credential-store reads — one `getSecureKeyAsync` per distinct ref, only
 * for credentials a reveal command in this turn already named. Refs that
 * fail to resolve (unknown id, missing secret, store unreachable) are
 * dropped; the corresponding spans persist as plain sentinels.
 */
export async function resolveRevealCandidates(
  refs: readonly RevealCandidateRef[],
): Promise<ResolvedRevealCandidate[]> {
  const seen = new Set<string>();
  const candidates: ResolvedRevealCandidate[] = [];
  for (const ref of refs) {
    let service = ref.service;
    let field = ref.field;
    if (ref.id !== undefined) {
      try {
        const meta = getCredentialMetadataById(ref.id);
        if (!meta) continue;
        service = meta.service;
        field = meta.field;
      } catch (err) {
        log.debug({ err }, "reveal candidate id lookup failed; skipping");
        continue;
      }
    }
    if (service === undefined || field === undefined) continue;
    const key = credentialKey(service, field);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const value = await getSecureKeyAsync(key);
      if (value != null && value.length > 0) {
        candidates.push({ service, field, value });
      }
    } catch (err) {
      // Store unreachable → no candidate → plain sentinel. Never block or
      // fail the persist over enrichment.
      log.debug(
        { err, service, field },
        "reveal candidate fetch failed; span will persist as plain sentinel",
      );
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Live-stream forgery guard
// ---------------------------------------------------------------------------

const SENTINEL_TRIGGER = `${REDACTED_SENTINEL_OPEN}${REDACTED_SENTINEL_TAG}:`;

/**
 * A reveal candidate prepared for live-stream substitution: when the model
 * echoes `value` into its reply, the stream guard swaps it for `replacement`
 * (the same enriched sentinel persist-time redaction produces) before the
 * bytes reach the wire — so the plaintext never flashes in the live
 * transcript and never leaves the daemon.
 */
export interface LiveRevealGuardEntry {
  /** Credential plaintext exactly as it would appear in model output. */
  value: string;
  /** The sentinel `redactSecretsForChat` produces for those bytes. */
  replacement: string;
}

/**
 * Precompute live-swap entries from resolved reveal candidates. Each entry's
 * replacement is what persist-time redaction produces for the bare value, so
 * the live stream and the persisted row agree byte-for-byte on redacted
 * spans. A value the secret scanner does not detect is dropped: persist
 * would leave it untouched, so swapping it live would make the stream and
 * the stored transcript disagree.
 */
export function buildLiveRevealGuardEntries(
  candidates: readonly ResolvedRevealCandidate[],
): LiveRevealGuardEntry[] {
  const entries: LiveRevealGuardEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // Dedupe by value — duplicate plaintexts would otherwise register two
    // entries and split/join order would silently pick one.
    if (seen.has(candidate.value)) {
      continue;
    }
    seen.add(candidate.value);
    // Derive the replacement against the FULL candidate list, exactly as
    // the persist seam does: a value shared by two identities degrades to
    // the plain type-only sentinel there (see `uniqueCandidateForValue`),
    // and the live swap must emit the same bytes or the streamed text and
    // the persisted row would disagree on reconnect.
    const replacement = redactSecretsForChat(candidate.value, candidates);
    if (replacement !== candidate.value) {
      entries.push({ value: candidate.value, replacement });
    }
  }
  return entries;
}

/**
 * Replace every occurrence of each entry's plaintext with its sentinel.
 * Longest value first: when one candidate's plaintext is a prefix (or
 * substring) of another's, insertion order would let the shorter entry
 * consume the head of the longer value — emitting the shorter chip plus
 * the longer credential's unmatched suffix as raw text, while persist-time
 * redaction (whose scanner prefers the longer span) redacts the whole
 * value. Descending-length ordering keeps the live swap consistent with
 * persistence; a replacement sentinel contains no credential bytes, so
 * later (shorter) entries can never match inside an earlier swap.
 */
export function swapLiveRevealValues(
  text: string,
  entries: readonly LiveRevealGuardEntry[],
): string {
  const ordered = [...entries].sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const entry of ordered) {
    if (out.includes(entry.value)) {
      out = out.split(entry.value).join(entry.replacement);
    }
  }
  return out;
}

/**
 * Length of the longest suffix of `text` that is a PROPER prefix of
 * `target` (a complete occurrence is not a hold-back case — the caller's
 * transform consumes it).
 */
function trailingProperPrefixLen(text: string, target: string): number {
  const maxLen = Math.min(target.length - 1, text.length);
  for (let len = maxLen; len > 0; len--) {
    if (text.endsWith(target.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Hold-back length for `target`: the longest suffix of `text` that is a
 * proper prefix of `target`, computed AFTER skipping complete occurrences
 * greedily left-to-right — the same non-overlapping semantics as the
 * split/join swap, so the two always agree on which bytes an occurrence
 * consumed. Without the skip, a value whose proper prefix is also its
 * suffix (`abcabc` chunked as `abc` + `abc`) matches the plain
 * trailing-prefix check on its OWN tail: the guard would split the
 * complete occurrence, emit the first half as raw plaintext, and the swap
 * would never see the full value.
 */
function trailingHoldLen(text: string, target: string): number {
  let scanFrom = 0;
  for (;;) {
    const idx = text.indexOf(target, scanFrom);
    if (idx === -1) {
      break;
    }
    scanFrom = idx + target.length;
  }
  return trailingProperPrefixLen(text.slice(scanFrom), target);
}

/**
 * Streaming redaction guard for live `assistant_text_delta` emission
 * (mirrors `drainDirectiveDisplayBuffer`'s hold-back pattern). Two jobs:
 *
 * 1. **Forgery neutralization** — genuine sentinels are created by the
 *    daemon, never in raw model output, so any sentinel-shaped string the
 *    model streams is forged; neutralizing all of them is lossless.
 * 2. **Live reveal swap** — a complete occurrence of a reveal candidate's
 *    plaintext is replaced with its enriched sentinel (`entries`), so the
 *    secret never flashes in the live stream: the client renders the chip
 *    immediately and the persisted row (which redacts the same bytes at
 *    persist time) matches what was streamed.
 *
 * A trailing PARTIAL trigger or candidate-value prefix (split across
 * streaming chunks) is held back in `bufferedRemainder` — at most
 * `max(trigger, longest candidate) - 1` characters — so the next chunk
 * decides whether it completes. Callers must re-prepend the remainder to
 * the next chunk and, at end-of-message, flush it through
 * `swapLiveRevealValues(neutralizeRedactedSentinels(...))` — nothing can
 * complete a partial prefix after the message ends.
 *
 * `consumedRaw` is the untransformed input the emit covers. Callers that
 * mirror streamed text for partial persistence must mirror `consumedRaw`,
 * not `emitText`: persist-time redaction re-derives the sentinel from the
 * raw bytes, whereas a mirrored already-swapped sentinel would be
 * indistinguishable from a forgery and get neutralized.
 */
export function drainSentinelGuardedText(
  buffer: string,
  entries: readonly LiveRevealGuardEntry[] = [],
): {
  emitText: string;
  consumedRaw: string;
  bufferedRemainder: string;
} {
  let holdLen = trailingHoldLen(buffer, SENTINEL_TRIGGER);
  for (const entry of entries) {
    const len = trailingHoldLen(buffer, entry.value);
    if (len > holdLen) {
      holdLen = len;
    }
  }
  const consumedRaw = buffer.slice(0, buffer.length - holdLen);
  return {
    emitText: swapLiveRevealValues(
      neutralizeRedactedSentinels(consumedRaw),
      entries,
    ),
    consumedRaw,
    bufferedRemainder: buffer.slice(buffer.length - holdLen),
  };
}

// ---------------------------------------------------------------------------
// Sentinel redaction
// ---------------------------------------------------------------------------

/**
 * Redact secrets in chat-persisted text using sentinels instead of the
 * legacy HTML marker. A span whose bytes exactly equal a candidate's
 * plaintext gets the enriched (revealable) shape — but only when that value
 * maps to exactly one vault identity; everything else gets the plain
 * type-only shape. Detection itself is unchanged — same scanner, same
 * patterns, same overlap handling as `redactSecrets`.
 */
export function redactSecretsForChat(
  text: string,
  candidates: readonly ResolvedRevealCandidate[],
): string {
  // Forgery guard: neutralize any sentinel-shaped string already present in
  // the raw text (model output, fetched content, quoted transcripts) so the
  // only sentinels that survive persistence are the ones inserted below from
  // an actually-detected secret. See the contract module for the mechanism.
  return redactSecretsWith(
    neutralizeRedactedSentinels(text),
    (match, rawValue) => {
      const hit = uniqueCandidateForValue(candidates, rawValue);
      return buildRedactedSentinel(
        hit
          ? { type: match.type, service: hit.service, field: hit.field }
          : { type: match.type },
      );
    },
  );
}

/**
 * Resolve a matched plaintext to a candidate identity — but only when the
 * mapping is unambiguous. A byte match proves the VALUE, not the vault
 * identity: if two revealed credentials happen to share the same plaintext
 * (the same API key stored under two services), picking either would mint a
 * chip whose label — and whose click-to-reveal path — names a credential the
 * user may not have revealed, and whose value silently diverges if that
 * credential later rotates. Duplicate-value spans therefore degrade to the
 * plain type-only sentinel. Multiple candidate entries that agree on
 * service:field (the same reveal parsed twice) are still unique.
 */
function uniqueCandidateForValue(
  candidates: readonly ResolvedRevealCandidate[],
  rawValue: string,
): ResolvedRevealCandidate | undefined {
  let hit: ResolvedRevealCandidate | undefined;
  for (const candidate of candidates) {
    if (candidate.value !== rawValue) {
      continue;
    }
    if (
      hit !== undefined &&
      (hit.service !== candidate.service || hit.field !== candidate.field)
    ) {
      return undefined;
    }
    hit = candidate;
  }
  return hit;
}
