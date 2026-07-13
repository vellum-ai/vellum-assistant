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

/** Longest suffix of `text` that is a proper prefix of the sentinel trigger. */
function trailingTriggerPrefix(text: string): string {
  const maxLen = Math.min(SENTINEL_TRIGGER.length - 1, text.length);
  for (let len = maxLen; len > 0; len--) {
    if (text.endsWith(SENTINEL_TRIGGER.slice(0, len))) {
      return SENTINEL_TRIGGER.slice(0, len);
    }
  }
  return "";
}

/**
 * Streaming counterpart of `neutralizeRedactedSentinels` for live
 * `assistant_text_delta` emission (mirrors `drainDirectiveDisplayBuffer`'s
 * hold-back pattern).
 *
 * Genuine sentinels are created at PERSIST time, never in raw model output —
 * so any sentinel-shaped string in the live stream is by definition forged,
 * and neutralizing all of them is lossless. Complete trigger prefixes in the
 * buffer are neutralized; a trailing PARTIAL trigger (a sentinel split
 * across streaming chunks) is held back in `bufferedRemainder` (at most
 * `trigger.length - 1` characters) so the next chunk decides whether it
 * completes into a trigger. Callers must re-prepend the remainder to the
 * next chunk and flush it raw at end-of-message — an incomplete prefix can
 * never match the chip regex.
 */
export function drainSentinelGuardedText(buffer: string): {
  emitText: string;
  bufferedRemainder: string;
} {
  const neutralized = neutralizeRedactedSentinels(buffer);
  const trailing = trailingTriggerPrefix(neutralized);
  return {
    emitText: neutralized.slice(0, neutralized.length - trailing.length),
    bufferedRemainder: trailing,
  };
}

// ---------------------------------------------------------------------------
// Sentinel redaction
// ---------------------------------------------------------------------------

/**
 * Redact secrets in chat-persisted text using sentinels instead of the
 * legacy HTML marker. A span whose bytes exactly equal a candidate's
 * plaintext gets the enriched (revealable) shape; everything else gets the
 * plain type-only shape. Detection itself is unchanged — same scanner, same
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
      const hit = candidates.find((c) => c.value === rawValue);
      return buildRedactedSentinel(
        hit
          ? { type: match.type, service: hit.service, field: hit.field }
          : { type: match.type },
      );
    },
  );
}
