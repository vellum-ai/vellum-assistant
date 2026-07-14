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
 * Split a shell command into segments at UNQUOTED separators (`&&`, `||`,
 * `;`, `|`, a lone `&`, newline). A separator inside a quoted flag value —
 * `--service 'R&D'` — is part of the value, and cutting there would orphan
 * the invocation's flags across two broken segments: no ref gets staged,
 * so the reveal's output could stream or persist raw even though the route
 * served it. Minimal POSIX-ish quoting: single quotes are literal to the
 * next single quote, double quotes honor backslash escapes, and a
 * backslash outside quotes escapes the next character. An unterminated
 * quote runs to the end of the string — the remainder stays one segment,
 * which at worst stages nothing (the same safe direction as before).
 * Quotes are kept in the output so the flag regexes see them.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = undefined;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length) {
        current += ch + command[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      if (ch === '"') quote = undefined;
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "&" || ch === "|") {
      // `&&`/`||` consume both characters so the two-char operator is one
      // boundary; a lone `&` (background job separator) or `|` splits too,
      // so a second backgrounded/piped reveal is staged rather than
      // swallowed into the first segment.
      segments.push(current);
      current = "";
      i += command[i + 1] === ch ? 2 : 1;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  segments.push(current);
  return segments;
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
  // another (`reveal --service a --field b && reveal --service c --field d`),
  // honoring quotes so a separator inside a flag value can't cut the
  // invocation apart (see `splitShellSegments`).
  const segments = splitShellSegments(command);
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
 * Resolve id-form refs to service/field EAGERLY, at staging time — a
 * metadata-only lookup, no secret access. Proof runs when the tool result
 * arrives, which can be well after the reveal executed, and a `credentials
 * remove` in between (even in the same compound command) makes the id
 * unresolvable then — dropping the ref although the route recorded the
 * success, so the printed value would persist raw. The id stays on the ref
 * so proof time can still fall back to a lookup for a ref whose metadata
 * only appears later.
 */
export function resolveRefIdentities(
  refs: readonly RevealCandidateRef[],
): RevealCandidateRef[] {
  return refs.map((ref) => {
    if (
      ref.id === undefined ||
      (ref.service !== undefined && ref.field !== undefined)
    ) {
      return ref;
    }
    try {
      const meta = getCredentialMetadataById(ref.id);
      if (!meta) return ref;
      return { ...ref, service: meta.service, field: meta.field };
    } catch (err) {
      log.debug(
        { err },
        "eager reveal ref id lookup failed; deferring to proof time",
      );
      return ref;
    }
  });
}

/**
 * Keep only refs whose identity the reveal route ACTUALLY served after
 * `watermark` was captured (see `reveal-success-registry`). A shell tool's
 * overall success is not proof the nested reveal ran — `reveal … || true`
 * succeeds when the route failed, and an `echo` containing the command
 * text never calls the route — so candidate resolution (which reads
 * plaintext from the store) must be gated on the route's own record.
 * Identity for id-form refs is normally captured at staging (see
 * `resolveRefIdentities`); the metadata lookup here is only a fallback —
 * metadata-only, no secret access. Unresolvable refs are dropped — the
 * safe direction.
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
    if (
      ref.id !== undefined &&
      (service === undefined || field === undefined)
    ) {
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
 * Append a candidate in EVERY stdout encoding of its plaintext, deduped on
 * identity+value. `credentials reveal --json` writes the value through
 * `JSON.stringify` (see the CLI's `writeOutput`), so a value containing
 * quotes, backslashes, or control characters — a PEM key's newlines —
 * appears in the tool's stdout ESCAPED: bytes a raw exact-match list can
 * never find, leaving the escaped body to the scanner (which only knows
 * the header). Registering the escaped encoding as its own candidate
 * covers that representation on every surface (persist byte-compare, live
 * guard, tool_result fallback, output chunks). `JSON.stringify` is
 * injective on the value, so an escaped-form match proves the same
 * identity the raw form does.
 */
function appendCandidateEncodings(
  candidates: ResolvedRevealCandidate[],
  seen: Set<string>,
  service: string,
  field: string,
  value: string,
): void {
  for (const encoded of [value, JSON.stringify(value).slice(1, -1)]) {
    if (encoded.length === 0) continue;
    const dedupeKey = JSON.stringify([service, field, encoded]);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push({ service, field, value: encoded });
  }
}

/**
 * Sync twin of {@link resolveRevealCandidates} for refs that already carry
 * a proven value (the shape `filterRefsByRevealProof` returns) — used on
 * the live tool-output path, whose handler must stay synchronous and may
 * not touch the vault. Refs without a proven value are skipped, never
 * vault-resolved.
 */
export function resolveProvenRevealCandidates(
  refs: readonly RevealCandidateRef[],
): ResolvedRevealCandidate[] {
  const seen = new Set<string>();
  const candidates: ResolvedRevealCandidate[] = [];
  for (const ref of refs) {
    if (ref.service === undefined || ref.field === undefined) continue;
    if (ref.provenValue === undefined || ref.provenValue.length === 0) {
      continue;
    }
    appendCandidateEncodings(
      candidates,
      seen,
      ref.service,
      ref.field,
      ref.provenValue,
    );
  }
  return candidates;
}

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
  const pushCandidate = (service: string, field: string, value: string) =>
    appendCandidateEncodings(candidates, seenCandidates, service, field, value);
  for (const ref of refs) {
    let service = ref.service;
    let field = ref.field;
    if (
      ref.id !== undefined &&
      (service === undefined || field === undefined)
    ) {
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
 *
 * `transformGap` is applied to the text BETWEEN spans (and to the whole
 * text when nothing matches). Callers use it for forgery neutralization:
 * it must run over raw bytes the spans do not claim, and never over the
 * spans themselves — a candidate value may itself contain the sentinel
 * trigger, and mutating it before the exact-match resolution would break
 * the strongest guarantee this module makes.
 */
function replaceRawSpans(
  text: string,
  targets: readonly string[],
  replacementFor: (priority: number) => string,
  transformGap: (segment: string) => string = (segment) => segment,
): string {
  const spans = resolveRawSpans(text, targets);
  if (spans.length === 0) {
    return transformGap(text);
  }
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out +=
      transformGap(text.slice(cursor, span.start)) +
      replacementFor(span.priority);
    cursor = span.end;
  }
  return out + transformGap(text.slice(cursor));
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
 * The live-emit transform: swap candidate values for their sentinels AND
 * neutralize forged sentinels — resolved together on the RAW bytes, with
 * neutralization applied only to the text between candidate spans.
 * Sequencing them instead (`swapLiveRevealValues(neutralizeRedactedSentinels(text))`)
 * breaks when a candidate's plaintext itself contains the sentinel trigger
 * (manual values are arbitrary strings): neutralization would mutate the
 * value's occurrence first, the exact-match swap would miss it, and an
 * opaque secret would cross the wire almost intact. Candidate spans win;
 * forgery neutralization covers everything they don't claim — exactly the
 * occurrence semantics `stableEmitLen` models when it analyzes the trigger
 * and the values as one priority-ordered target set.
 */
export function neutralizeAndSwapLiveRevealValues(
  text: string,
  entries: readonly LiveRevealGuardEntry[],
): string {
  const ordered = [...entries].sort((a, b) => b.value.length - a.value.length);
  return replaceRawSpans(
    text,
    ordered.map((entry) => entry.value),
    (priority) => ordered[priority].replacement,
    neutralizeRedactedSentinels,
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
 * Each case guards a real leak shape: a self-overlapping value chunked at
 * the overlap boundary (`abcabc` as `abc`+`abc`: the own-tail threat is
 * moot, the occurrence commits whole); a candidate whose tail is a prefix
 * of a longer candidate (the threat outranks it, so it is held whole —
 * emitting it would leak the longer value's suffix raw once it
 * completes); equal-length overlapping entries (`aba`/`bab`: the
 * earlier-sorted entry outranks, so a completed `bab` holds while `aba`
 * may still complete — keeping chunked output identical to the unchunked
 * swap).
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
 * `neutralizeAndSwapLiveRevealValues` — nothing can complete a partial
 * prefix after the message ends.
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
    emitText: neutralizeAndSwapLiveRevealValues(consumedRaw, entries),
    consumedRaw,
    bufferedRemainder: buffer.slice(emitLen),
  };
}

/**
 * Streaming redaction guard for live `tool_output_chunk` emission — the
 * tool-output twin of {@link drainSentinelGuardedText}. A foreground
 * reveal's stdout streams to the client WHILE the tool runs, before the
 * tool_result seam redacts the final content, so each chunk must be
 * redacted on the way out or the plaintext shows in the tool drawer until
 * the redacted result replaces it. Complete occurrences of candidate
 * values become the legacy marker (this surface renders no chips, and the
 * final tool_result row uses the same treatment, so live and persisted
 * bytes agree); a trailing partial occurrence is held back in
 * `bufferedRemainder` for the tool's next chunk — the tool_result seam
 * flushes whatever remains.
 */
export function drainCandidateGuardedChunk(
  buffer: string,
  candidates: readonly ResolvedRevealCandidate[],
): { emitText: string; bufferedRemainder: string } {
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
  const emitLen = stableEmitLen(buffer, values);
  return {
    emitText: redactCandidateValuesLegacy(buffer.slice(0, emitLen), candidates),
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
  // Candidate spans resolve FIRST, on the raw bytes; forgery
  // neutralization and the scanner then run ONLY over the text between
  // them (the gap transform below). Raw bytes first because a manual
  // candidate value may itself contain the sentinel trigger — mutating it
  // up front would break the exact-match pass, the strongest guarantee
  // here. Before the scanner because the scanner may only recognize a
  // SUBSTRING of a proven plaintext (the `Private Key` pattern consumes
  // just the `-----BEGIN … -----` header, leaving the key body), and once
  // it has replaced that substring the full candidate value is no longer
  // present for an exact-match pass to find — the body would
  // stream/persist raw. Gaps only because a minted sentinel is not
  // scanner-inert: its service/field segments are arbitrary user strings
  // that can themselves look secret-shaped, and a scanner match inside a
  // fresh sentinel would corrupt it into a nested, unrenderable marker.
  //
  // Within each gap the scanner still redacts secrets the reveal registry
  // never proved (defense in depth against any secret the model emitted
  // that the vault did not serve), with the precise type label for values
  // it classifies inline.
  const redactGap = (segment: string): string =>
    redactSecretsWith(
      neutralizeRedactedSentinels(segment),
      (match, rawValue) => {
        const hit = uniqueCandidateForValue(candidates, rawValue);
        return buildRedactedSentinel(
          hit
            ? { type: match.type, service: hit.service, field: hit.field }
            : { type: match.type },
        );
      },
    );
  return protectCandidateSpans(text, candidates, redactGap);
}

/**
 * Replace every occurrence of a proven candidate plaintext with its sentinel,
 * applying `transformGap` (the caller's neutralize+scan pipeline) only to the
 * text between the spans. Candidate spans are resolved on the RAW bytes (a
 * manual value may itself contain the sentinel trigger, and neutralizing
 * first would break the exact match), and protection precedes the scanner so
 * a value the scanner would only partially match (e.g. a PEM key, where only
 * the header is recognized) is still redacted as a whole — its body can
 * never survive into the streamed/persisted text. Minted sentinels are never
 * fed back through `transformGap`: their service/field segments are
 * arbitrary user strings that can look secret-shaped, and a scanner rewrite
 * inside a fresh sentinel would corrupt it.
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
  transformGap: (segment: string) => string,
): string {
  if (candidates.length === 0) {
    return transformGap(text);
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
  return replaceRawSpans(
    text,
    values,
    (priority) => sentinelForValue(values[priority]),
    transformGap,
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
  // Protect every proven candidate value as an atomic legacy marker
  // (neutralizing forged sentinels in the text between the spans), THEN run
  // the scanner over what remains. Candidate spans resolve on the RAW
  // bytes: a manual value may itself contain the sentinel trigger, and
  // neutralizing the whole text first would mutate the occurrence and
  // break the exact match. Candidate protection must precede the scanner:
  // a value the scanner only partially recognizes (a PEM key, where the
  // `Private Key` pattern consumes just the header) would otherwise have
  // its recognized substring replaced first, destroying the full-value
  // match so the key body persists raw. The inserted `<redacted … />`
  // markers contain no secret-shaped bytes, so the scanner pass can
  // neither re-match nor corrupt them.
  const protectedText = protectCandidateValuesLegacy(text, candidates);
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
    return neutralizeRedactedSentinels(text);
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
    neutralizeRedactedSentinels,
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
