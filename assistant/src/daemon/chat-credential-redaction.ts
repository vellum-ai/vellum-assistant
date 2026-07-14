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

import { revealedValuesSince } from "../runtime/reveal-success-registry.js";
import { credentialKey } from "../security/credential-key.js";
import {
  redactSecrets,
  redactSecretsWith,
  scanText,
} from "../security/secret-scanner.js";
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
  /**
   * The plaintext the reveal route served for this ref, captured by
   * {@link filterRefsByRevealProof} at proof time. When present, candidate
   * resolution redacts these EXACT bytes and skips the vault read — so a
   * rotation/deletion between reveal and persist can't make the redacted
   * value diverge from what the tool actually printed. Absent only for refs
   * that were never proven (which resolution drops anyway).
   */
  provenValue?: string;
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
  // `&&` and `||` are listed before the single-char `&`/`|` so the two-char
  // operators win at a given position; a lone `&` (background job separator,
  // e.g. `reveal … & reveal …`) splits too, so a second backgrounded reveal
  // is staged rather than swallowed into the first segment.
  const segments = command.split(/(?:&&|\|\||[;&|\n])/);
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
  const proven: RevealCandidateRef[] = [];
  const seenValues = new Set<string>();
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
        log.debug({ err }, "reveal proof id lookup failed; dropping ref");
        continue;
      }
    }
    if (service === undefined || field === undefined) continue;
    // Capture the plaintexts the route served alongside the proof, in the
    // same lookup. Resolving service/field here too means each returned ref
    // is fully self-describing, so candidate resolution needs neither the
    // metadata lookup nor the vault read again. One ref PER DISTINCT VALUE:
    // a rotate-and-re-reveal inside the window (reveal v1 → `credentials
    // set` → reveal v2) prints two different plaintexts to stdout, and
    // keeping only one would let the other persist raw whenever the scanner
    // cannot classify it.
    for (const provenValue of revealedValuesSince(watermark, service, field)) {
      const dedupeKey = JSON.stringify([service, field, provenValue]);
      if (seenValues.has(dedupeKey)) continue;
      seenValues.add(dedupeKey);
      proven.push({ service, field, provenValue });
    }
  }
  return proven;
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
  // Candidates dedupe on identity AND value, not identity alone: the same
  // credential legitimately yields two candidates when it was rotated and
  // re-revealed within one turn — both plaintexts hit a tool's stdout, so
  // both must stay redactable. Vault reads still dedupe per identity (one
  // scoped read per credential, and the vault only has the current value).
  const seenCandidates = new Set<string>();
  const vaultReadKeys = new Set<string>();
  const candidates: ResolvedRevealCandidate[] = [];
  const pushCandidate = (service: string, field: string, value: string) => {
    const dedupeKey = JSON.stringify([service, field, value]);
    if (seenCandidates.has(dedupeKey)) return;
    seenCandidates.add(dedupeKey);
    candidates.push({ service, field, value });
  };
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
    // Prefer the plaintext the reveal route actually served (captured at proof
    // time). Re-reading the vault here would return a rotated or deleted
    // value, so the guard/fallback could miss the exact bytes the tool
    // printed. Only fall back to a store read when a ref carries no proven
    // value — which today means it was constructed outside the proof path.
    if (ref.provenValue !== undefined && ref.provenValue.length > 0) {
      pushCandidate(service, field, ref.provenValue);
      continue;
    }
    const key = credentialKey(service, field);
    if (vaultReadKeys.has(key)) continue;
    vaultReadKeys.add(key);
    try {
      const value = await getSecureKeyAsync(key);
      if (value != null && value.length > 0) {
        pushCandidate(service, field, value);
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
 * off the wire, whatever the surrounding text turns out to be — and each
 * replacement is exactly what persist-time redaction produces for the
 * bare value, so the live stream and the persisted row agree
 * byte-for-byte. `redactSecretsForChat` guarantees a candidate value
 * never survives: the scanner classifies what it can, and the exact-match
 * fallback (see `swapCandidateValueFallbacks`) covers the rest — opaque
 * manual tokens and values the scanner only matches with surrounding
 * context. The lone residual divergence: a contextual persist match
 * (`password=<value>`) may carry a more specific type label than the
 * bare-value chip streamed live — cosmetic, same service:field identity.
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
    // the plain sentinel there (see `uniqueCandidateForValue`), and the
    // live swap must emit the same bytes or the streamed text and the
    // persisted row would disagree on reconnect.
    entries.push({
      value: candidate.value,
      replacement: redactSecretsForChat(candidate.value, candidates),
    });
  }
  return entries;
}

/** A non-overlapping occurrence of a target in raw text. */
interface RawSpan {
  start: number;
  end: number;
  /** Index into the caller's target list — lower = higher priority. */
  priority: number;
}

/**
 * Resolve the non-overlapping occurrence spans of `targets` in `text`:
 * targets in priority order (list index — callers sort longest-first so a
 * value that is a substring of another cannot pre-empt the larger match),
 * each target's occurrences greedy left-to-right, skipping any occurrence
 * that overlaps a higher-priority span. This is the single definition of
 * the transforms' occurrence semantics: every swap in this module rebuilds
 * its output from these spans, and the streaming stability analysis
 * (`stableEmitLen`) resolves through the same function, so the two can
 * never drift.
 */
function resolveRawSpans(text: string, targets: readonly string[]): RawSpan[] {
  const spans: RawSpan[] = [];
  targets.forEach((target, priority) => {
    if (target.length === 0) {
      return;
    }
    let scanFrom = 0;
    for (;;) {
      const idx = text.indexOf(target, scanFrom);
      if (idx === -1) {
        break;
      }
      const end = idx + target.length;
      // An occurrence overlapping a higher-priority span loses to it — the
      // higher-priority replacement consumes those bytes — but keep
      // scanning from the next byte for a later disjoint occurrence.
      if (spans.some((s) => idx < s.end && end > s.start)) {
        scanFrom = idx + 1;
        continue;
      }
      spans.push({ start: idx, end, priority });
      scanFrom = end;
    }
  });
  return spans;
}

/**
 * Replace each resolved raw span with its target's replacement, rebuilding
 * the string in ONE pass over the original text. A sequential
 * split/join-per-target pass would re-scan earlier replacements — and a
 * replacement sentinel is not inert text: it embeds type/service/field
 * segments, so a candidate whose plaintext happens to equal another's
 * service name (e.g. `openai`) would match inside the just-emitted
 * sentinel and corrupt it into nested, unrenderable markers. Resolving all
 * spans against the raw text first makes replacements structurally
 * invisible to later targets.
 */
function replaceRawSpans(
  text: string,
  targets: readonly string[],
  replacementFor: (priority: number) => string,
): string {
  const spans = resolveRawSpans(text, targets);
  if (spans.length === 0) {
    return text;
  }
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + replacementFor(span.priority);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * Replace every occurrence of each entry's plaintext with its sentinel.
 * Longest value first: when one candidate's plaintext is a prefix (or
 * substring) of another's, insertion order would let the shorter entry
 * consume the head of the longer value — emitting the shorter chip plus
 * the longer credential's unmatched suffix as raw text, while persist-time
 * redaction (whose scanner prefers the longer span) redacts the whole
 * value. Descending-length ordering keeps the live swap consistent with
 * persistence, and the span-based rebuild (`replaceRawSpans`) guarantees a
 * later entry can never rewrite inside an earlier entry's emitted
 * sentinel.
 */
export function swapLiveRevealValues(
  text: string,
  entries: readonly LiveRevealGuardEntry[],
): string {
  const ordered = [...entries].sort((a, b) => b.value.length - a.value.length);
  return replaceRawSpans(
    text,
    ordered.map((entry) => entry.value),
    (priority) => ordered[priority].replacement,
  );
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
  // Same span resolution as the swap transforms — shared so the stability
  // analysis can never disagree with what the transform actually consumes.
  const consumed = resolveRawSpans(buffer, targets);
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
  const neutralized = neutralizeRedactedSentinels(text);
  // Candidate protection runs BEFORE the scanner. A proven plaintext is a
  // secret whole; the scanner, however, may only recognize a SUBSTRING of it
  // (the `Private Key` pattern consumes just the `-----BEGIN … -----` header,
  // leaving the key body), and once the scanner has replaced that substring
  // the full candidate value is no longer present for an exact-match pass to
  // find — the body would stream/persist raw. Replacing each proven value as
  // an atomic unit up front closes that gap: the scanner then only ever sees
  // text outside any candidate span. The inserted sentinels use corner
  // brackets that are not part of any secret pattern, so the scanner pass
  // below can neither match nor corrupt them.
  const candidatePass = protectCandidateSpans(neutralized, candidates);
  // Scanner pass over the remainder. Values fully classified inline still get
  // their precise type label here; candidate values were already removed, so
  // this only redacts secrets the reveal registry never proved (defense in
  // depth against any secret the model emitted that the vault did not serve).
  return redactSecretsWith(candidatePass, (match, rawValue) => {
    const hit = uniqueCandidateForValue(candidates, rawValue);
    return buildRedactedSentinel(
      hit
        ? { type: match.type, service: hit.service, field: hit.field }
        : { type: match.type },
    );
  });
}

/**
 * Replace every occurrence of a proven candidate plaintext with its sentinel
 * BEFORE the scanner runs, so a value the scanner would only partially match
 * (e.g. a PEM key, where only the header is recognized) is still redacted as
 * a whole and its body can never survive into the streamed/persisted text.
 *
 * Longest value first (mirroring `swapLiveRevealValues`) so a value that is a
 * substring of another does not pre-empt the larger match; the span-based
 * rebuild (`replaceRawSpans`) keeps one value's sentinel safe from another
 * value that happens to appear inside it. Each value is
 * classified by scanning it in isolation: when a single scanner match spans
 * the ENTIRE value the precise type label is preserved (a recognizable key
 * keeps "Anthropic API Key" rather than degrading to the generic type);
 * otherwise the generic `Credential` type is used. Identity enrichment still
 * requires a unique vault match, exactly as the scanner path.
 */
function protectCandidateSpans(
  text: string,
  candidates: readonly ResolvedRevealCandidate[],
): string {
  if (candidates.length === 0) {
    return text;
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const candidate of candidates) {
    if (candidate.value.length === 0 || seen.has(candidate.value)) {
      continue;
    }
    seen.add(candidate.value);
    values.push(candidate.value);
  }
  values.sort((a, b) => b.length - a.length);
  const sentinelCache = new Map<string, string>();
  const sentinelForValue = (value: string): string => {
    let sentinel = sentinelCache.get(value);
    if (sentinel === undefined) {
      const hit = uniqueCandidateForValue(candidates, value);
      sentinel = buildRedactedSentinel(
        hit
          ? {
              type: classifyCandidateType(value),
              service: hit.service,
              field: hit.field,
            }
          : { type: classifyCandidateType(value) },
      );
      sentinelCache.set(value, sentinel);
    }
    return sentinel;
  };
  return replaceRawSpans(text, values, (priority) =>
    sentinelForValue(values[priority]),
  );
}

/**
 * The scanner type label for a candidate value, or the generic `Credential`
 * type when the scanner does not recognize it. The value is scanned in
 * isolation (so no neighbouring match bleeds in) and a match ANCHORED AT THE
 * START is used — a value that begins with a recognized signature is that
 * type even when the pattern consumes only a prefix (the `Private Key`
 * pattern matches just the `-----BEGIN … -----` header, yet the value is
 * unambiguously a private key). The longest such anchored match wins.
 * Matches that merely appear mid-value are ignored: they could be a
 * coincidental substring, and mislabelling a chip is worse than the generic
 * type. Identity enrichment is still gated on a unique vault match upstream,
 * so the label never drives which secret a chip can reveal.
 */
function classifyCandidateType(value: string): string {
  let best: { type: string; endIndex: number } | undefined;
  for (const m of scanText(value)) {
    if (m.startIndex !== 0) continue;
    if (best === undefined || m.endIndex > best.endIndex) {
      best = { type: m.type, endIndex: m.endIndex };
    }
  }
  return best?.type ?? FALLBACK_SENTINEL_TYPE;
}

/**
 * Legacy-marker twin of the persist fallback, for surfaces that keep the
 * `<redacted type/>` marker instead of sentinels (persisted tool_result
 * blocks — see `buildToolResultBlocks`). A `credentials reveal` whose
 * stdout is an opaque/manual value with no scanner-recognizable shape
 * would otherwise persist raw in the tool-result row and surface in the
 * tool detail panel and history, even though every other surface redacts
 * it. Exact occurrences of proven candidate plaintexts (deduped, longest
 * value first) become the generic legacy marker; no identity is carried —
 * these surfaces render no chips.
 */
export function redactCandidateValuesLegacy(
  text: string,
  candidates: readonly ResolvedRevealCandidate[],
): string {
  // Neutralize forged sentinels, protect every proven candidate value as an
  // atomic legacy marker, THEN run the scanner over what remains. Candidate
  // protection must precede the scanner: a value the scanner only partially
  // recognizes (a PEM key, where the `Private Key` pattern consumes just the
  // header) would otherwise have its recognized substring replaced first,
  // destroying the full-value match so the key body persists raw. The
  // inserted `<redacted … />` markers contain no secret-shaped bytes, so the
  // scanner pass can neither re-match nor corrupt them.
  const protectedText = protectCandidateValuesLegacy(
    neutralizeRedactedSentinels(text),
    candidates,
  );
  return redactSecrets(protectedText);
}

/**
 * Replace every occurrence of a proven candidate plaintext with the generic
 * legacy marker BEFORE the scanner runs (longest value first, mirroring
 * `swapLiveRevealValues`). Twin of {@link protectCandidateSpans} for surfaces
 * that keep the `<redacted type="…" />` marker instead of sentinels; no
 * identity is carried — these surfaces render no chips, so the generic type
 * is always used.
 */
function protectCandidateValuesLegacy(
  text: string,
  candidates: readonly ResolvedRevealCandidate[],
): string {
  if (candidates.length === 0) {
    return text;
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const candidate of candidates) {
    if (candidate.value.length === 0 || seen.has(candidate.value)) {
      continue;
    }
    seen.add(candidate.value);
    values.push(candidate.value);
  }
  values.sort((a, b) => b.length - a.length);
  return replaceRawSpans(
    text,
    values,
    () => `<redacted type="${FALLBACK_SENTINEL_TYPE}" />`,
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
