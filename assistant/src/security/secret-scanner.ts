/**
 * Secret scanner — detects leaked secrets (API keys, tokens, passwords,
 * private keys, connection strings) in arbitrary text.  Patterns are curated
 * from gitleaks and detect-secrets.
 */

import { getLogger } from "../util/logger.js";
import { isAllowlisted } from "./secret-allowlist.js";
import { PREFIX_PATTERNS } from "./secret-patterns.js";

const log = getLogger("secret-scanner");

export interface SecretMatch {
  /** Human-readable type label, e.g. "AWS Access Key" */
  type: string;
  /** Byte offset of the match start in the input text */
  startIndex: number;
  /** Byte offset one past the match end */
  endIndex: number;
  /** The matched value with middle portion masked */
  redactedValue: string;
}

export interface SecretPattern {
  type: string;
  regex: RegExp;
}

// ---------------------------------------------------------------------------
// Known-format patterns
// ---------------------------------------------------------------------------

// Patterns that need custom boundary handling instead of simple \b wrapping.
// Telegram: last char can be '-' (not a word char), so \b fails.
// Private Key: starts with '-----' (not word chars), so \b fails.
const CUSTOM_BOUNDARY: Record<string, (src: string) => string> = {
  "Telegram Bot Token": (src) => `\\b(${src})(?=[^A-Za-z0-9_-]|$)`,
  "Private Key": (src) => `(${src})`,
};

// Derive prefix-based patterns from the shared source of truth, adding
// capture groups and the global flag that scanText() expects.
const PREFIX_DERIVED: SecretPattern[] = PREFIX_PATTERNS.map((p) => {
  const src = p.regex.source;
  const custom = CUSTOM_BOUNDARY[p.label];
  const pattern = custom ? custom(src) : `\\b(${src})\\b`;
  return {
    type: p.label,
    regex: new RegExp(pattern, "g"),
  };
});

// Scanner-only patterns that require surrounding context or are not
// simple prefix matches — these stay defined here.
const SCANNER_ONLY_PATTERNS: SecretPattern[] = [
  {
    type: "AWS Secret Key",
    // 40 chars of base-64 alphabet, preceded by a key-value separator.
    // Must contain mixed case AND special chars (+/) to distinguish from
    // hex strings like git SHAs.
    regex: /(?<=['"=:\s])([A-Za-z0-9+/]{40})(?=\s|['"]|$)/g,
  },

  {
    type: "Slack Webhook",
    regex:
      /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+)/g,
  },

  {
    type: "Heroku API Key",
    // Require a heroku-related keyword prefix to avoid flagging every UUID
    regex:
      /(?:heroku[_-]?api[_-]?key|HEROKU[_-]?API[_-]?KEY|heroku[_-]?auth[_-]?token)\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/gi,
  },

  {
    type: "JSON Web Token",
    regex: /\b(eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]+)/g,
  },

  {
    type: "Database Connection String",
    regex:
      /((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mssql|redis|amqp|amqps):\/\/[^\s'"]+)/g,
  },

  // Generic "password" / "secret" / "token" assignments (quoted)
  {
    type: "Generic Secret Assignment",
    regex:
      /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|credentials)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
  },
  // Generic assignments (unquoted, e.g. .env files)
  {
    type: "Generic Secret Assignment",
    regex:
      /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|credentials)\s*=\s*([^\s'"]{8,})/gi,
  },
];

const PATTERNS: SecretPattern[] = [...PREFIX_DERIVED, ...SCANNER_ONLY_PATTERNS];

// ---------------------------------------------------------------------------
// Known placeholder values that should NOT be flagged
// ---------------------------------------------------------------------------

const PLACEHOLDER_VALUES = new Set([
  // AWS
  "AKIAIOSFODNN7EXAMPLE",
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  // Generic
  "your-api-key-here",
  "your-secret-key-here",
  "your_api_key_here",
  "your_secret_key_here",
  "INSERT_YOUR_API_KEY",
  "INSERT_YOUR_SECRET_KEY",
  "REPLACE_ME",
  "changeme",
  "password",
  "xxxxxxxx",
  "TODO",
]);

const PLACEHOLDER_PREFIXES = [
  "sk-test-",
  "sk_test_",
  "pk_test_",
  "rk_test_",
  "test_",
  "fake_",
  "dummy_",
  "example_",
  "sample_",
];

// Heroku-style UUIDs that are just zeros or sequential
const ZERO_UUID = /^[0-]{36}$/;
const SEQUENTIAL_UUID = /^01234567-/;

// ---------------------------------------------------------------------------
// Redaction helper
// ---------------------------------------------------------------------------

function redact(value: string): string {
  if (value.length <= 8) return "***";
  const visiblePrefix = Math.min(4, Math.floor(value.length * 0.15));
  const visibleSuffix = Math.min(4, Math.floor(value.length * 0.15));
  const masked = value.length - visiblePrefix - visibleSuffix;
  return `${value.slice(0, visiblePrefix)}${"*".repeat(
    Math.min(masked, 20),
  )}${value.slice(-visibleSuffix)}`;
}

// ---------------------------------------------------------------------------
// Placeholder detection
// ---------------------------------------------------------------------------

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();

  if (PLACEHOLDER_VALUES.has(value) || PLACEHOLDER_VALUES.has(lower)) {
    return true;
  }

  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }

  // UUID-shaped values that are clearly fake
  if (ZERO_UUID.test(value) || SEQUENTIAL_UUID.test(value)) {
    return true;
  }

  // All same character repeated
  if (/^(.)\1+$/.test(value)) return true;

  // Contains obvious placeholder words — only when the word appears as the
  // dominant content, not incidentally (e.g. "db.example.com" in a URL should
  // not be suppressed).  Require that placeholder words appear at a word
  // boundary and the value doesn't look like a URL.
  if (!/^[a-z]+:\/\//i.test(value)) {
    if (
      /(?:^|[_\-\s])(?:example|placeholder|dummy|fake|your|insert|replace)(?:[_\-\s]|$)/i.test(
        value,
      )
    ) {
      return true;
    }
  }

  // Repeated 'x' sequences (4+) as obvious placeholders
  if (/x{4,}/i.test(value) && !/[0-9a-wyz]/i.test(value.replace(/x/gi, ""))) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// AWS Secret Key validation — must contain mixed case to avoid matching
// hex-only strings like git SHAs
// ---------------------------------------------------------------------------

function isLikelyAwsSecret(value: string): boolean {
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasSpecial = /[+/]/.test(value);
  // Real AWS secrets have mixed case; pure-hex strings (git SHAs) don't
  return (hasUpper && hasLower) || hasSpecial;
}

// ---------------------------------------------------------------------------
// Entropy-based detection
// ---------------------------------------------------------------------------

export interface EntropyConfig {
  /** Enable entropy-based scanning. Default: true */
  enabled: boolean;
  /** Minimum Shannon entropy (bits per char) for hex tokens. Default: 3.0 */
  hexThreshold: number;
  /** Minimum Shannon entropy (bits per char) for base64 tokens. Default: 4.0 */
  base64Threshold: number;
  /** Minimum token length to consider. Default: 20 */
  minLength: number;
}

export const DEFAULT_ENTROPY_CONFIG: EntropyConfig = {
  enabled: true,
  hexThreshold: 3.0,
  base64Threshold: 4.0,
  minLength: 20,
};

/**
 * Calculate Shannon entropy in bits per character.
 * Higher entropy = more random = more likely to be a secret.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Keywords that, when adjacent to a high-entropy token, boost confidence. */
const SECRET_CONTEXT_KEYWORDS = [
  "key",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "api_key",
  "api-key",
  "apikey",
  "access_key",
  "access-key",
  "accesskey",
  "auth_token",
  "auth-token",
  "authtoken",
  "bearer",
  "authorization",
  "credential",
  "credentials",
  "private_key",
  "private-key",
  "client_secret",
  "client-secret",
  "signing_key",
  "signing-key",
  "encryption_key",
  "encryption-key",
];

/** Match hex strings (20+ chars of [0-9a-fA-F]) */
const HEX_TOKEN_RE = /\b([0-9a-fA-F]{20,})\b/g;

/** Match base64 strings (20+ chars of [A-Za-z0-9+/_-]) with optional = padding.
 *  Trailing \b would fail after '=' (non-word char), so we use a lookahead. */
const BASE64_TOKEN_RE = /\b([A-Za-z0-9+/\-_]{20,}={0,3})(?=\W|$)/g;

/**
 * Check whether a token appears near a secret-related keyword in the
 * surrounding text (up to 60 chars before the match).
 */
/** Pre-compiled word-boundary regex for each context keyword. */
const SECRET_CONTEXT_RES = SECRET_CONTEXT_KEYWORDS.map(
  (kw) =>
    new RegExp(
      `(?:^|[^a-z0-9])${kw.replace(/[-]/g, "\\$&")}(?:[^a-z0-9]|$)`,
      "i",
    ),
);

function hasSecretContext(text: string, matchStart: number): boolean {
  // Look at up to 60 chars before the token for context keywords
  const contextStart = Math.max(0, matchStart - 60);
  const prefix = text.slice(contextStart, matchStart);
  return SECRET_CONTEXT_RES.some((re) => re.test(prefix));
}

/**
 * Check if a string is purely hex characters.
 */
function isHex(s: string): boolean {
  return /^[0-9a-fA-F]+$/.test(s);
}

/**
 * Check if a string looks like base64 (has mixed case or base64 special chars).
 */
function isBase64Like(s: string): boolean {
  return /[A-Za-z]/.test(s) && /[0-9]/.test(s) && /[+/\-_=]/.test(s);
}

/**
 * Scan for high-entropy tokens that may be secrets not matching known patterns.
 * Returns matches only for tokens with entropy above the configured threshold
 * AND that appear in a secret-related context (near keywords like "key", "token",
 * "password", etc.).
 */
function scanEntropy(
  text: string,
  config: EntropyConfig,
  existingRanges: Set<string>,
): SecretMatch[] {
  if (!config.enabled) return [];
  const matches: SecretMatch[] = [];

  // Scan hex tokens
  HEX_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEX_TOKEN_RE.exec(text)) != null) {
    const value = m[1];
    if (value.length < config.minLength) continue;
    const startIndex = m.index;
    const endIndex = startIndex + value.length;

    // Skip if already covered by a pattern match
    const key = `${startIndex}:${endIndex}`;
    if (existingRanges.has(key)) continue;

    // Skip placeholders and allowlisted values
    if (isPlaceholder(value)) continue;
    if (isAllowlisted(value)) continue;

    const entropy = shannonEntropy(value);
    if (entropy < config.hexThreshold) continue;

    // Require secret-related context to reduce false positives
    if (!hasSecretContext(text, startIndex)) continue;

    existingRanges.add(key);
    matches.push({
      type: "High-Entropy Hex Token",
      startIndex,
      endIndex,
      redactedValue: redact(value),
    });
  }

  // Scan base64 tokens
  BASE64_TOKEN_RE.lastIndex = 0;
  while ((m = BASE64_TOKEN_RE.exec(text)) != null) {
    const value = m[1];
    if (value.length < config.minLength) continue;
    // Must look like base64 (not pure alphanumeric) or pure hex
    if (isHex(value)) continue; // Already handled above
    if (!isBase64Like(value) && !/[A-Z]/.test(value)) continue;

    const startIndex = m.index;
    const endIndex = startIndex + value.length;

    const key = `${startIndex}:${endIndex}`;
    if (existingRanges.has(key)) continue;

    if (isPlaceholder(value)) continue;
    if (isAllowlisted(value)) continue;

    const entropy = shannonEntropy(value);
    if (entropy < config.base64Threshold) continue;

    if (!hasSecretContext(text, startIndex)) continue;

    existingRanges.add(key);
    matches.push({
      type: "High-Entropy Base64 Token",
      startIndex,
      endIndex,
      redactedValue: redact(value),
    });
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Encoded secret detection — decode + re-scan pass
// ---------------------------------------------------------------------------

/**
 * Find percent-encoded segments containing 3+ encoded bytes, using a linear
 * scan instead of a regex with nested quantifiers (which caused catastrophic
 * backtracking on long near-miss inputs).
 */
function findPercentEncodedSegments(
  text: string,
): Array<{ start: number; end: number; match: string }> {
  const results: Array<{ start: number; end: number; match: string }> = [];
  const len = text.length;
  const isUrlChar = (ch: string) => /[A-Za-z0-9_.~+/\-]/.test(ch);
  const isHexDigit = (ch: string) => /[0-9A-Fa-f]/.test(ch);

  let i = 0;
  while (i < len) {
    // Look for the start of a percent-encoded segment
    if (text[i] !== "%" && !isUrlChar(text[i])) {
      i++;
      continue;
    }

    // Walk a candidate segment of URL-safe chars and %XX sequences
    const start = i;
    let pctCount = 0;
    while (i < len) {
      if (
        text[i] === "%" &&
        i + 2 < len &&
        isHexDigit(text[i + 1]) &&
        isHexDigit(text[i + 2])
      ) {
        pctCount++;
        i += 3;
      } else if (isUrlChar(text[i])) {
        i++;
      } else {
        break;
      }
    }

    if (pctCount >= 3) {
      results.push({ start, end: i, match: text.slice(start, i) });
    }
    // Avoid re-scanning the same position if we didn't advance
    if (i === start) i++;
  }
  return results;
}

/** Hex-escape sequences: \xHH patterns (3+ consecutive) */
const HEX_ESCAPE_RE = /(?:\\x[0-9A-Fa-f]{2}){3,}/g;

/** Candidate base64 segments — 24+ chars that could encode a secret (≥18 decoded bytes) */
const ENCODED_BASE64_RE = /\b([A-Za-z0-9+/\-_]{24,}={0,3})(?=\W|$)/g;

/** Continuous hex-encoded bytes — 32+ hex chars (16+ bytes decoded) */
const CONTINUOUS_HEX_RE = /\b([0-9a-fA-F]{32,})\b/g;

/** Check if decoded content is printable ASCII text */
function isPrintableText(s: string): boolean {
  return s.length > 0 && /^[\x20-\x7E\t\n\r]+$/.test(s);
}

function tryDecodeBase64(encoded: string): string | null {
  try {
    // Handle both standard and URL-safe base64
    const standardized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(standardized, "base64").toString("utf-8");
    if (!isPrintableText(decoded)) return null;
    // Verify round-trip to reject garbage decodes
    const reEncoded = Buffer.from(decoded, "utf-8")
      .toString("base64")
      .replace(/=+$/, "");
    if (standardized.replace(/=+$/, "") !== reEncoded) return null;
    return decoded;
  } catch {
    return null;
  }
}

function tryDecodePercentEncoded(encoded: string): string | null {
  try {
    const decoded = decodeURIComponent(encoded);
    if (decoded === encoded) return null;
    if (!isPrintableText(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function tryDecodeHexEscapes(encoded: string): string | null {
  try {
    const decoded = encoded.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    if (decoded === encoded) return null;
    if (!isPrintableText(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function tryDecodeContinuousHex(encoded: string): string | null {
  try {
    // Odd-length strings can't be decoded as pairs of hex digits
    if (encoded.length % 2 !== 0) return null;
    // Decode pairs of hex digits to bytes
    const bytes: number[] = [];
    for (let i = 0; i < encoded.length; i += 2) {
      bytes.push(parseInt(encoded.slice(i, i + 2), 16));
    }
    const decoded = String.fromCharCode(...bytes);
    if (!isPrintableText(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Check if an encoded segment overlaps with any existing match range */
function overlapsExisting(
  start: number,
  end: number,
  ranges: Set<string>,
): boolean {
  for (const rangeKey of ranges) {
    const sep = rangeKey.indexOf(":");
    const rStart = Number(rangeKey.slice(0, sep));
    const rEnd = Number(rangeKey.slice(sep + 1));
    if (start < rEnd && end > rStart) return true;
  }
  return false;
}

/**
 * Scan for encoded secrets by decoding candidate segments and running
 * pattern matching on the decoded content. Catches base64-encoded,
 * hex-encoded, and percent-encoded secrets that raw regex would miss.
 */
function scanEncoded(
  text: string,
  existingRanges: Set<string>,
  customPatterns?: SecretPattern[],
): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const allPatterns = customPatterns?.length
    ? [...PATTERNS, ...customPatterns]
    : PATTERNS;

  // Helper: try to match decoded content against known secret patterns
  const tryMatchDecoded = (
    encoded: string,
    decoded: string,
    startIndex: number,
    endIndex: number,
    encoding: string,
  ) => {
    for (const pattern of allPatterns) {
      pattern.regex.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = pattern.regex.exec(decoded)) != null) {
        if (pm[0].length === 0) {
          pattern.regex.lastIndex++;
          continue;
        }
        const value = pm[1] ?? pm[0];
        if (isPlaceholder(value)) continue;
        if (isAllowlisted(value)) continue;
        if (pattern.type === "AWS Secret Key" && !isLikelyAwsSecret(value))
          continue;

        const key = `${startIndex}:${endIndex}`;
        existingRanges.add(key);
        matches.push({
          type: `${pattern.type} (${encoding})`,
          startIndex,
          endIndex,
          redactedValue: redact(encoded),
        });
        return;
      }
    }
  };

  // Percent-encoded segments: use linear-time scanner instead of regex
  if (text.includes("%")) {
    for (const seg of findPercentEncodedSegments(text)) {
      if (seg.match.length > 1000) continue;
      if (overlapsExisting(seg.start, seg.end, existingRanges)) continue;
      const decoded = tryDecodePercentEncoded(seg.match);
      if (!decoded) continue;
      tryMatchDecoded(
        seg.match,
        decoded,
        seg.start,
        seg.end,
        "percent-encoded",
      );
    }
  }

  // Regex-based decoders for the remaining encodings
  const decoders: Array<{
    regex: RegExp;
    decode: (s: string) => string | null;
    encoding: string;
    quickCheck?: (t: string) => boolean;
  }> = [
    {
      regex: HEX_ESCAPE_RE,
      decode: tryDecodeHexEscapes,
      encoding: "hex-escaped",
      quickCheck: (t) => t.includes("\\x"),
    },
    {
      regex: ENCODED_BASE64_RE,
      decode: tryDecodeBase64,
      encoding: "base64-encoded",
    },
    {
      regex: CONTINUOUS_HEX_RE,
      decode: tryDecodeContinuousHex,
      encoding: "hex-encoded",
    },
  ];

  for (const { regex, decode, encoding, quickCheck } of decoders) {
    if (quickCheck && !quickCheck(text)) continue;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) != null) {
      const encoded = m[1] ?? m[0];
      if (encoded.length > 1000) continue;
      const startIndex = m.index + m[0].indexOf(encoded);
      const endIndex = startIndex + encoded.length;

      if (overlapsExisting(startIndex, endIndex, existingRanges)) continue;

      const decoded = decode(encoded);
      if (!decoded) continue;

      tryMatchDecoded(encoded, decoded, startIndex, endIndex, encoding);
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Custom pattern support
// ---------------------------------------------------------------------------

export interface CustomPatternInput {
  label: string;
  pattern: string;
}

/**
 * Compile user-provided custom patterns into SecretPattern objects.
 * Invalid regex patterns and patterns that can match empty strings are
 * logged and skipped — an empty-match pattern would cause infinite loops
 * in the `while (regex.exec(...))` scanning loops.
 */
export function compileCustomPatterns(
  inputs: CustomPatternInput[],
): SecretPattern[] {
  const compiled: SecretPattern[] = [];
  for (const { label, pattern } of inputs) {
    try {
      const regex = new RegExp(pattern, "g");
      if (regex.test("")) {
        log.warn(
          { label, pattern },
          "Skipping custom secret pattern that matches empty strings",
        );
        continue;
      }
      // Zero-width assertions (lookaheads, \b, etc.) pass the empty-string check
      // but still produce zero-length matches on real text, stalling the exec loop.
      regex.lastIndex = 0;
      const sampleMatch = regex.exec(
        "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-/+=",
      );
      regex.lastIndex = 0;
      if (sampleMatch && sampleMatch[0].length === 0) {
        log.warn(
          { label, pattern },
          "Skipping custom secret pattern that produces zero-length matches",
        );
        continue;
      }
      compiled.push({ type: label, regex });
    } catch (err) {
      log.warn(
        { label, pattern, error: String(err) },
        "Skipping invalid custom secret pattern",
      );
    }
  }
  return compiled;
}

// ---------------------------------------------------------------------------
// Scan function
// ---------------------------------------------------------------------------

/**
 * Scan text for leaked secrets. Returns an array of matches sorted by
 * position. Each match includes the secret type, position, and a redacted
 * preview of the matched value.
 *
 * @param entropyConfig — optional config for entropy-based scanning.
 *   Pass `{ enabled: false }` to disable. Defaults to DEFAULT_ENTROPY_CONFIG.
 * @param customPatterns — optional user-defined patterns to apply alongside built-in ones.
 */
export function scanText(
  text: string,
  entropyConfig?: Partial<EntropyConfig>,
  customPatterns?: SecretPattern[],
): SecretMatch[] {
  const matches: SecretMatch[] = [];
  // De-duplicate overlapping ranges (a match can fire on multiple patterns)
  const seen = new Set<string>();

  const allPatterns = customPatterns?.length
    ? [...PATTERNS, ...customPatterns]
    : PATTERNS;

  for (const pattern of allPatterns) {
    // Reset lastIndex for global regexes
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(text)) != null) {
      // Prevent infinite loops from zero-length matches (e.g. lookaheads, \b)
      if (m[0].length === 0) {
        pattern.regex.lastIndex++;
        continue;
      }
      // Use first capturing group if present, otherwise full match
      const value = m[1] ?? m[0];
      const startIndex = m.index + m[0].indexOf(value);
      const endIndex = startIndex + value.length;

      if (isPlaceholder(value)) continue;
      if (isAllowlisted(value)) continue;

      // Extra validation for AWS Secret Keys to avoid hex-string false positives
      if (pattern.type === "AWS Secret Key" && !isLikelyAwsSecret(value))
        continue;

      const key = `${startIndex}:${endIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);

      matches.push({
        type: pattern.type,
        startIndex,
        endIndex,
        redactedValue: redact(value),
      });
    }
  }

  // Entropy-based scanning for tokens that don't match known patterns
  const eConfig = { ...DEFAULT_ENTROPY_CONFIG, ...entropyConfig };
  const entropyMatches = scanEntropy(text, eConfig, seen);
  matches.push(...entropyMatches);

  // Encoded secret detection — decode candidate segments and re-scan
  const encodedMatches = scanEncoded(text, seen, customPatterns);
  matches.push(...encodedMatches);

  // Sort by position; at same start, wider match first so redaction covers the full span
  matches.sort(
    (a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex,
  );
  return matches;
}

/**
 * Replace detected secrets in text with redaction markers.
 * Returns the modified text.
 */
export function redactSecrets(
  text: string,
  entropyConfig?: Partial<EntropyConfig>,
  customPatterns?: SecretPattern[],
): string {
  const matches = scanText(text, entropyConfig, customPatterns);
  if (matches.length === 0) return text;

  let result = "";
  let lastIndex = 0;

  for (const match of matches) {
    if (match.startIndex < lastIndex) {
      // Overlapping match — extend the redacted span if this one reaches further
      if (match.endIndex > lastIndex) {
        lastIndex = match.endIndex;
      }
      continue;
    }
    result += text.slice(lastIndex, match.startIndex);
    result += `<redacted type="${match.type}" />`;
    lastIndex = match.endIndex;
  }
  result += text.slice(lastIndex);

  return result;
}

// Exported for testing only
export {
  hasSecretContext as _hasSecretContext,
  isPlaceholder as _isPlaceholder,
  redact as _redact,
  tryDecodeBase64 as _tryDecodeBase64,
  tryDecodeContinuousHex as _tryDecodeContinuousHex,
  tryDecodeHexEscapes as _tryDecodeHexEscapes,
  tryDecodePercentEncoded as _tryDecodePercentEncoded,
};
