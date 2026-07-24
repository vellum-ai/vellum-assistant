/**
 * Shared prefix-based secret patterns — the single source of truth.
 *
 * Ingress blocking, tool output scanning, log redaction, and client-side
 * composer detection all consume this list.  When adding a new integration,
 * add its API key pattern here.
 *
 * This module is intentionally data-only: no imports, no entropy logic,
 * no config — safe for hot-path consumers like log serializers, and
 * browser-safe so web clients can bundle it directly.
 *
 * The exported `PATTERNS`/constants are shared verbatim by the daemon and the
 * web clients, so the two sides agree on what a secret *looks like*. The web
 * composer scanner is a conservative superset pre-filter of the daemon ingress
 * check, not an identical twin: the daemon additionally applies a per-user
 * secret allowlist and config gating (`secretDetection.enabled` /
 * `blockIngress`) on top of these shared patterns, so the client may warn on a
 * few values the server would accept (e.g. an allowlisted token). Only the
 * shared patterns and length bounds in this module are guaranteed identical
 * across client and server.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretPrefixPattern {
  /** Human-readable label shown in block notices and redaction tags. */
  label: string;
  /**
   * Regex that matches the token value.  Must NOT include the `g` flag or
   * capture groups — consumers add those as needed.
   */
  regex: RegExp;
}

// ---------------------------------------------------------------------------
// Prefix patterns
// ---------------------------------------------------------------------------

/**
 * High-confidence, prefix-based secret patterns.
 *
 * Each entry matches a known API key / token format by its distinctive
 * prefix.  Patterns that require surrounding context (entropy analysis,
 * keyword proximity, URL structure) do NOT belong here — they stay in
 * `secret-scanner.ts` as scanner-only patterns.
 *
 * **When adding a new third-party integration, add its API key pattern
 * here.**  If the service uses only opaque OAuth access tokens (no fixed
 * prefix), no pattern is needed.
 */
/** Detection label for PEM private-key matches. */
export const PRIVATE_KEY_LABEL = "Private Key";

// PEM private-key header/footer type variants, shared by the Private Key
// pattern and the complete-block check.
const PEM_KEY_TYPE = String.raw`(?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY(?:\s+BLOCK)?`;
const PEM_BEGIN = String.raw`-----BEGIN ${PEM_KEY_TYPE}-----`;
const PEM_END = String.raw`-----END ${PEM_KEY_TYPE}-----`;

const PEM_COMPLETE_BLOCK = new RegExp(`${PEM_END}$`);

/**
 * Header-only private-key matcher: matches just the `-----BEGIN … PRIVATE
 * KEY-----` header, with no optional block-body capture.
 *
 * Detect/redact-only consumers (log serializers, the tool-output scanner) use
 * this instead of the whole-block {@link PREFIX_PATTERNS} entry: they only need
 * to KNOW a private key is present and mask it — they never store or rewrite
 * the block — so they must not pay the O(n²) cost the whole-block matcher incurs
 * on large serialized strings, where every footerless header rescans to EOF
 * looking for a footer. `detectSecretsInText` (chat) keeps the whole-block
 * matcher, which the store/rewrite path relies on to capture the full key.
 */
export const PRIVATE_KEY_HEADER_REGEX = new RegExp(PEM_BEGIN);

/**
 * True when a `Private Key` match is a complete PEM block — it ends at an
 * `-----END … PRIVATE KEY-----` footer (the pattern guarantees it starts at
 * the BEGIN header). A header-only match means the footer is absent from
 * the scanned text (truncated or partial paste), so the match does NOT
 * cover the key body: storing or replacing such a value would leave key
 * material behind.
 */
export function isCompletePrivateKeyBlock(value: string): boolean {
  return PEM_COMPLETE_BLOCK.test(value);
}

export const PREFIX_PATTERNS: SecretPrefixPattern[] = [
  // -- Private keys --
  // First in the list on purpose: `detectSecretsInText` resolves overlapping
  // spans by list order, and a PEM body is base64 — it can embed runs that
  // look like other tokens (e.g. `AKIA` + 16 chars). The whole-block match
  // must win those overlaps or the block would be fragmented.
  {
    label: PRIVATE_KEY_LABEL,
    // Matches the entire PEM block (header through footer) when the END
    // footer is present, so consumers that store or replace the matched
    // value handle the whole key. The block tail is optional: a header with
    // no footer (truncated or streamed partial paste) still matches alone,
    // which ingress blocking relies on. The body is tempered — it never
    // crosses another BEGIN header — so adjacent blocks match separately.
    regex: new RegExp(
      `${PEM_BEGIN}(?:(?:(?!-----BEGIN)[\\s\\S])*?${PEM_END})?`,
    ),
  },

  // -- AWS --
  { label: "AWS Access Key", regex: /AKIA[0-9A-Z]{16}/ },

  // -- GitHub --
  { label: "GitHub Token", regex: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { label: "GitHub Fine-Grained PAT", regex: /github_pat_[A-Za-z0-9_]{22,}/ },

  // -- GitLab --
  { label: "GitLab Token", regex: /glpat-[A-Za-z0-9\-_]{20,}/ },

  // -- Stripe --
  { label: "Stripe Secret Key", regex: /sk_live_[A-Za-z0-9]{24,}/ },
  { label: "Stripe Restricted Key", regex: /rk_live_[A-Za-z0-9]{24,}/ },

  // -- Slack --
  {
    label: "Slack Bot Token",
    regex: /xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/,
  },
  {
    label: "Slack User Token",
    regex: /xoxp-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[a-f0-9]{32}/,
  },
  {
    label: "Slack App Token",
    regex: /xapp-[0-9]+-[A-Za-z0-9]+-[0-9]+-[A-Za-z0-9]+/,
  },

  // -- Telegram --
  {
    label: "Telegram Bot Token",
    // Format: <bot_id>:<secret> where bot_id is 8–10 digits, secret is 35 chars
    regex: /[0-9]{8,10}:[A-Za-z0-9_-]{35}/,
  },

  // -- Anthropic --
  { label: "Anthropic API Key", regex: /sk-ant-[A-Za-z0-9\-_]{80,}/ },

  // -- OpenAI --
  {
    label: "OpenAI API Key",
    regex: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/,
  },
  { label: "OpenAI Project Key", regex: /sk-proj-[A-Za-z0-9\-_]{40,}/ },

  // -- Google --
  { label: "Google API Key", regex: /AIza[A-Za-z0-9\-_]{35}/ },
  {
    label: "Google OAuth Client Secret",
    regex: /GOCSPX-[A-Za-z0-9\-_]{28}/,
  },

  // -- Twilio --
  { label: "Twilio API Key", regex: /SK[0-9a-f]{32}/ },

  // -- SendGrid --
  {
    label: "SendGrid API Key",
    regex: /SG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43}/,
  },

  // -- Mailgun --
  { label: "Mailgun API Key", regex: /key-[A-Za-z0-9]{32}/ },

  // -- npm --
  { label: "npm Token", regex: /npm_[A-Za-z0-9]{36}/ },

  // -- PyPI --
  { label: "PyPI API Token", regex: /pypi-[A-Za-z0-9\-_]{50,}/ },

  // -- Linear --
  { label: "Linear API Key", regex: /lin_api_[A-Za-z0-9]{32,}/ },

  // -- Notion --
  { label: "Notion Integration Token", regex: /ntn_[A-Za-z0-9]{40,}/ },

  // -- OpenRouter --
  { label: "OpenRouter API Key", regex: /sk-or-v1-[A-Za-z0-9\-_]{40,}/ },

  // -- Vercel AI Gateway --
  { label: "Vercel AI Gateway API Key", regex: /vck_[A-Za-z0-9\-_]{24,}/ },

  // -- Fireworks --
  { label: "Fireworks API Key", regex: /fw_[A-Za-z0-9]{32,}/ },

  // -- Perplexity --
  { label: "Perplexity API Key", regex: /pplx-[A-Za-z0-9]{40,}/ },

  // -- Tavily --
  { label: "Tavily API Key", regex: /tvly-[A-Za-z0-9]{20,}/ },

  // -- Firecrawl --
  { label: "Firecrawl API Key", regex: /fc-[A-Za-z0-9]{20,}/ },
];

/**
 * {@link PREFIX_PATTERNS} variant for detect/redact-only consumers (log
 * serializers, the tool-output scanner). Identical to `PREFIX_PATTERNS` except
 * the private-key entry matches the PEM header alone
 * ({@link PRIVATE_KEY_HEADER_REGEX}): those consumers only DETECT or REDACT a
 * private key — they never store or rewrite the block — so they route here to
 * avoid the whole-block matcher's O(n²) worst case on large serialized strings.
 * `detectSecretsInText` (chat) uses `PREFIX_PATTERNS` for full-block capture.
 */
export const REDACTION_PREFIX_PATTERNS: SecretPrefixPattern[] =
  PREFIX_PATTERNS.map((p) =>
    p.label === PRIVATE_KEY_LABEL
      ? { label: PRIVATE_KEY_LABEL, regex: PRIVATE_KEY_HEADER_REGEX }
      : p,
  );

// ---------------------------------------------------------------------------
// Token-shape heuristic (whole-message only)
// ---------------------------------------------------------------------------

/**
 * A single token-shaped value: an alphanumeric head, a separator-delimited
 * secret keyword infix, and a >=16-char tail (e.g. `virlo_tkn_JF…`). The
 * capture group isolates the tail for placeholder checks. Applied only when
 * the entire trimmed message is one such token — the whole-message and
 * keyword-infix requirements keep false positives near zero without any
 * entropy scoring.
 */
export const TOKEN_SHAPE =
  /^[A-Za-z0-9][A-Za-z0-9_-]*[_-](?:tkn|token|key|secret|api|pat|sk|auth)[_-]([A-Za-z0-9_-]{16,})$/i;

/**
 * Length bounds for the whole-message token-shape heuristic, shared by the
 * daemon ingress check and the web composer scanner so both accept and reject
 * the same whole-message tokens. Below the min a "token" is too short to be a
 * plausible secret; above the max it is almost certainly a paste of something
 * else (a base64 blob, a minified line) rather than a single credential.
 */
export const TOKEN_SHAPE_MIN_LENGTH = 20;
export const TOKEN_SHAPE_MAX_LENGTH = 512;

/** Detection label for a whole-message token-shape match, shared by the daemon
 * ingress check and the web composer scanner so both report the same
 * user-facing type. */
export const TOKEN_SHAPE_LABEL = "Token-shaped value";

// ---------------------------------------------------------------------------
// Placeholder suppression (ingress semantics: user-typed input, near-zero
// false positives)
// ---------------------------------------------------------------------------

export const KNOWN_PLACEHOLDERS = new Set([
  "your-api-key-here",
  "your_api_key_here",
  "insert-your-key-here",
  "insert_your_key_here",
  "replace-with-your-key",
  "replace_with_your_key",
  "xxx",
  "xxxxxxxx",
  "test",
  "example",
  "sample",
  "demo",
  "placeholder",
  "changeme",
  "CHANGEME",
  "TODO",
  "FIXME",
  "your-token-here",
  "your_token_here",
  "my-api-key",
  "my_api_key",
]);

export const PLACEHOLDER_PREFIXES = [
  "sk-test-",
  "sk_test_",
  "fake_",
  "fake-",
  "dummy_",
  "dummy-",
  "test_",
  "test-",
  "example_",
  "example-",
  "sample_",
  "sample-",
  "mock_",
  "mock-",
];

/**
 * Check if the text immediately before a matched value indicates a
 * placeholder context (e.g. "fake_", "test_"): true when the pre-context
 * window ends with any `PLACEHOLDER_PREFIXES` entry, case-insensitive.
 */
export function isPlaceholderContext(preContext: string): boolean {
  const lower = preContext.toLowerCase();
  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (lower.endsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a matched value is a placeholder/test value that should not be
 * reported: exact `KNOWN_PLACEHOLDERS` membership, a `PLACEHOLDER_PREFIXES`
 * prefix (both case-insensitive), or a variable portion that is one repeated
 * character (e.g. `AKIA` + `X` x 16).
 */
export function isPlaceholderValue(value: string): boolean {
  const lower = value.toLowerCase();
  if (KNOWN_PLACEHOLDERS.has(lower)) {
    return true;
  }
  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return true;
    }
  }

  // Repeated characters in the variable portion (e.g. "AKIA" + "X" x 16)
  // Strip known prefixes to isolate the variable part
  const variablePart = value
    .replace(
      /^(?:AKIA|gh[pousr]_|github_pat_|glpat-|sk_live_|rk_live_|xoxb-|xoxp-|xapp-|sk-ant-|sk-proj-|sk-or-v1-|AIza|GOCSPX-|SK|SG\.|npm_|pypi-|key-|lin_api_|ntn_|fw_|pplx-|-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
      "",
    )
    .replace(/[^A-Za-z0-9]/g, "");
  if (variablePart.length >= 8) {
    const firstChar = variablePart[0];
    if (variablePart.split("").every((c) => c === firstChar)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Draft scanner
// ---------------------------------------------------------------------------

export interface DetectedSecret {
  /** Human-readable secret type label, e.g. "Anthropic API Key". */
  label: string;
  /** The matched secret text. */
  value: string;
  /** Start offset of the match in the scanned text (inclusive). */
  start: number;
  /** End offset of the match in the scanned text (exclusive). */
  end: number;
  /** True when the entire trimmed text is one token-shaped value. */
  wholeMessage: boolean;
}

/**
 * Global clones of {@link PREFIX_PATTERNS}, compiled once so the draft
 * scanner never mutates the shared pattern objects' `lastIndex` and never
 * recompiles on the hot path (the composer scans on every draft change).
 */
const GLOBAL_PREFIX_PATTERNS: SecretPrefixPattern[] = PREFIX_PATTERNS.map(
  ({ label, regex }) => ({
    label,
    regex: new RegExp(
      regex.source,
      regex.flags.includes("g") ? regex.flags : regex.flags + "g",
    ),
  }),
);

/**
 * Scan a draft message for high-confidence secrets.
 *
 * Runs every `PREFIX_PATTERNS` entry over the text, suppressing placeholder
 * values and matches immediately preceded by a placeholder context (e.g.
 * `fake_` before a real-looking token) — the same suppression the daemon
 * applies at ingress, so client and server accept the same placeholders.
 * When no prefix pattern matches, the trimmed whole message is
 * tested against {@link TOKEN_SHAPE} — the same whole-message token-shape
 * heuristic the daemon blocks at ingress. Overlapping spans are deduped
 * (first pattern in list order wins); results are sorted by `start`.
 */
export function detectSecretsInText(text: string): DetectedSecret[] {
  const matches: DetectedSecret[] = [];

  for (const { label, regex } of GLOBAL_PREFIX_PATTERNS) {
    // Reset lastIndex — the compiled global regexes are shared across calls.
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const value = match[0];

      // Skip placeholders and test values (check both the match and
      // a small window before it for placeholder prefixes like "fake_")
      const contextStart = Math.max(0, match.index - 10);
      const preContext = text.slice(contextStart, match.index);
      if (isPlaceholderValue(value) || isPlaceholderContext(preContext)) {
        continue;
      }
      const start = match.index;
      const end = start + value.length;
      // Overlap dedupe: the first pattern in list order wins.
      if (matches.some((m) => start < m.end && end > m.start)) {
        continue;
      }
      matches.push({ label, value, start, end, wholeMessage: false });
    }
  }

  if (matches.length === 0) {
    const trimmed = text.trim();
    const shapeMatch =
      trimmed.length >= TOKEN_SHAPE_MIN_LENGTH &&
      trimmed.length <= TOKEN_SHAPE_MAX_LENGTH
        ? TOKEN_SHAPE.exec(trimmed)
        : null;
    if (
      shapeMatch !== null &&
      !isPlaceholderValue(trimmed) &&
      !isPlaceholderValue(shapeMatch[1]!)
    ) {
      const start = text.length - text.trimStart().length;
      matches.push({
        label: TOKEN_SHAPE_LABEL,
        value: trimmed,
        start,
        end: start + trimmed.length,
        wholeMessage: true,
      });
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}
