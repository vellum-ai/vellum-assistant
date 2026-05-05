/**
 * Secret scanner — detects leaked secrets (API keys, tokens, private keys,
 * connection strings, JWTs, and generic credential-style assignments) in
 * arbitrary text via known-prefix and shape-based regex patterns. Patterns
 * are curated from gitleaks and detect-secrets.
 *
 * Used by the explicit `redactSecrets()` callers (shell command summaries,
 * approval prompts, guardian prompts, activity text). Log redaction has its
 * own prefix-only path in `util/log-redact.ts`.
 */

import { isAllowlisted } from "./secret-allowlist.js";
import { PREFIX_PATTERNS } from "./secret-patterns.js";

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

interface SecretPattern {
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
// Scan function
// ---------------------------------------------------------------------------

/**
 * Scan text for leaked secrets. Returns an array of matches sorted by
 * position. Each match includes the secret type, position, and a redacted
 * preview of the matched value.
 */
export function scanText(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  // De-duplicate overlapping ranges (a match can fire on multiple patterns)
  const seen = new Set<string>();

  for (const pattern of PATTERNS) {
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
export function redactSecrets(text: string): string {
  const matches = scanText(text);
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
export { isPlaceholder as _isPlaceholder };
