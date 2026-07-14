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

import { hasRevealSuccessSince } from "../runtime/reveal-success-registry.js";
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

/**
 * Keep only refs whose identity the reveal route ACTUALLY served after
 * `watermark` was captured (see `reveal-success-registry`). A shell tool's
 * overall success is not proof the nested reveal ran — `reveal … || true`
 * succeeds when the route failed, and an `echo` containing the command
 * text never calls the route — so candidate resolution (which reads
 * plaintext from the store) must be gated on the route's own record.
 * Identity for id-form refs comes from the metadata store: a
 * metadata-only lookup, no secret access. Unresolvable refs are dropped —
 * the safe direction.
 */
export function filterRefsByRevealProof(
  refs: readonly RevealCandidateRef[],
  watermark: number,
): RevealCandidateRef[] {
  return refs.filter((ref) => {
    let service = ref.service;
    let field = ref.field;
    if (ref.id !== undefined) {
      try {
        const meta = getCredentialMetadataById(ref.id);
        if (!meta) return false;
        service = meta.service;
        field = meta.field;
      } catch (err) {
        log.debug({ err }, "reveal proof id lookup failed; dropping ref");
        return false;
      }
    }
    if (service === undefined || field === undefined) return false;
    return hasRevealSuccessSince(watermark, service, field);
  });
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
 * Fallback type label for a candidate whose bare value the scanner cannot
 * classify on its own (context-sensitive patterns like `password=…`).
 */
const FALLBACK_SENTINEL_TYPE = "Credential";

/**
 * Precompute live-swap entries from resolved reveal candidates. Every
 * candidate gets an entry — the guard's job is to keep revealed plaintext
 * off the wire, whatever the surrounding text turns out to be.
 *
 * When the scanner detects the bare value, the replacement is exactly what
 * persist-time redaction produces, so the live stream and the persisted
 * row agree byte-for-byte. When it does not — several scanner patterns
 * only match WITH context (`password=<value>`, `token: "<value>"`,
 * lookbehind-anchored shapes), so "bare value undetected" does not mean
 * "persist will keep it" — a generic-typed sentinel is built directly
 * from the candidate identity. Dropping such values entirely (the old
 * behavior) let `password=<revealed value>` cross the live stream raw
 * while final persistence redacted it: the secret sat in the live
 * transcript until refresh. The residual divergence is bounded and safe
 * in both directions: a contextual persist match may carry a more
 * specific type label than the live chip (cosmetic), and a value persist
 * never redacts shows a chip live where the stored row keeps the text —
 * the stream can only ever be MORE redacted than the transcript.
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
      continue;
    }
    // Scanner miss on the bare value: build the sentinel directly, with
    // the same unique-identity degrade rule as the persist seam.
    const hit = uniqueCandidateForValue(candidates, candidate.value);
    entries.push({
      value: candidate.value,
      replacement: buildRedactedSentinel(
        hit
          ? {
              type: FALLBACK_SENTINEL_TYPE,
              service: hit.service,
              field: hit.field,
            }
          : { type: FALLBACK_SENTINEL_TYPE },
      ),
    });
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
 * Length of the prefix of `buffer` whose transform result is STABLE —
 * i.e. cannot change no matter what bytes arrive next — under the
 * transform's occurrence semantics: targets resolved in priority order
 * (the caller passes them highest-priority first, matching
 * `swapLiveRevealValues`' longest-value-first stable sort), each target's
 * occurrences greedy left-to-right, non-overlapping with higher-priority
 * spans. Everything past the returned offset must be held back.
 *
 * Two steps:
 *
 * 1. Resolve the consumed spans of the CURRENT buffer exactly as the
 *    swap would.
 * 2. Find every "threat": a suffix of the buffer that is a proper prefix
 *    of some target `T` — bytes a future chunk could complete into a
 *    `T`-occurrence. Each threat pulls the stable boundary back:
 *    - threat starts OUTSIDE any consumed span → hold from the threat
 *      start (the classic split-value hold);
 *    - threat starts INSIDE a consumed span of occurrence `E`:
 *      - `priority(T)` higher than `priority(E)` → the future `T` match
 *        would beat `E` in the full-text swap, so `E` cannot be
 *        committed yet — hold from `E`'s START (emitting any part of
 *        `E` would leak raw bytes on one continuation or emit the wrong
 *        replacement on the other);
 *      - otherwise → `E` wins regardless of future bytes (greedy
 *        left-to-right for the same target, priority order across
 *        targets), so the threat is moot — `E` commits whole.
 *
 * Prior leaks each map to a case above: round 8 (self-overlap `abcabc`
 * chunked `abc`+`abc`: own-tail threat is moot, occurrence commits
 * whole), round 11 (candidate A's tail is a prefix of longer candidate
 * B: threat outranks A, A is held whole — emitting A would leak B's
 * suffix raw when B completes), round 12 (equal-length `aba`/`bab`:
 * earlier-sorted entry outranks, so a completed `bab` holds while `aba`
 * may still complete — keeping chunked output identical to the
 * unchunked swap).
 *
 * The boundary never splits a consumed span: it lands either outside
 * all spans or exactly on a span's start.
 */
function stableEmitLen(buffer: string, targets: readonly string[]): number {
  const consumed: Array<{ start: number; end: number; priority: number }> = [];
  targets.forEach((target, priority) => {
    if (target.length === 0) {
      return;
    }
    let scanFrom = 0;
    for (;;) {
      const idx = buffer.indexOf(target, scanFrom);
      if (idx === -1) {
        break;
      }
      const end = idx + target.length;
      // An occurrence overlapping a higher-priority consumed span no
      // longer exists in the transformed text (replacements contain no
      // credential bytes) — skip it, but keep scanning from the next
      // byte for a later disjoint occurrence.
      if (consumed.some((s) => idx < s.end && end > s.start)) {
        scanFrom = idx + 1;
        continue;
      }
      consumed.push({ start: idx, end, priority });
      scanFrom = end;
    }
  });
  let emitLen = buffer.length;
  targets.forEach((target, priority) => {
    const maxLen = Math.min(target.length - 1, buffer.length);
    for (let len = maxLen; len > 0; len--) {
      if (!buffer.endsWith(target.slice(0, len))) {
        continue;
      }
      const start = buffer.length - len;
      const host = consumed.find((s) => s.start <= start && start < s.end);
      if (host === undefined) {
        if (start < emitLen) {
          emitLen = start;
        }
      } else if (priority < host.priority && host.start < emitLen) {
        emitLen = host.start;
      }
    }
  });
  return emitLen;
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
 * streaming chunks) is held back in `bufferedRemainder` so the next chunk
 * decides whether it completes; when that partial prefix could outrank a
 * completed occurrence it starts inside, the whole occurrence is held with
 * it (see `stableEmitLen`), so the remainder is bounded by roughly twice
 * the longest target. Callers must re-prepend the remainder to
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
  // Priority order must mirror the transforms exactly:
  // `swapLiveRevealValues` sorts entries longest-value-first (stable),
  // and the trigger joins the same ordering so its complete occurrences
  // (consumed by neutralization) participate in the stability analysis.
  const targets = [
    SENTINEL_TRIGGER,
    ...entries.map((entry) => entry.value),
  ].sort((a, b) => b.length - a.length);
  const emitLen = stableEmitLen(buffer, targets);
  const consumedRaw = buffer.slice(0, emitLen);
  return {
    emitText: swapLiveRevealValues(
      neutralizeRedactedSentinels(consumedRaw),
      entries,
    ),
    consumedRaw,
    bufferedRemainder: buffer.slice(emitLen),
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
