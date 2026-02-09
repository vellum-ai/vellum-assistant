/**
 * Secret scanner — detects leaked secrets (API keys, tokens, passwords,
 * private keys, connection strings) in arbitrary text.  Patterns are curated
 * from gitleaks and detect-secrets.
 */

import { isAllowlisted } from './secret-allowlist.js';

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

const PATTERNS: SecretPattern[] = [
  // -- AWS --
  {
    type: 'AWS Access Key',
    regex: /\b(AKIA[0-9A-Z]{16})\b/g,
  },
  {
    type: 'AWS Secret Key',
    // 40 chars of base-64 alphabet, preceded by a key-value separator.
    // Must contain mixed case AND special chars (+/) to distinguish from
    // hex strings like git SHAs.
    regex: /(?<=['"=:\s])([A-Za-z0-9+/]{40})(?=\s|['"]|$)/g,
  },

  // -- GitHub --
  {
    type: 'GitHub Token',
    // ghp_ (PAT), gho_ (OAuth), ghu_ (user-to-server), ghs_ (server-to-server), ghr_ (refresh)
    regex: /\b(gh[pousr]_[A-Za-z0-9_]{36,255})\b/g,
  },
  {
    type: 'GitHub Fine-Grained PAT',
    regex: /\b(github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },

  // -- GitLab --
  {
    type: 'GitLab Token',
    regex: /\b(glpat-[A-Za-z0-9\-_]{20,})\b/g,
  },

  // -- Stripe --
  {
    type: 'Stripe Secret Key',
    regex: /\b(sk_live_[A-Za-z0-9]{24,})\b/g,
  },
  {
    type: 'Stripe Restricted Key',
    regex: /\b(rk_live_[A-Za-z0-9]{24,})\b/g,
  },

  // -- Slack --
  {
    type: 'Slack Bot Token',
    regex: /\b(xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,})\b/g,
  },
  {
    type: 'Slack User Token',
    regex: /\b(xoxp-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[a-f0-9]{32})\b/g,
  },
  {
    type: 'Slack Webhook',
    regex: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+)/g,
  },

  // -- Anthropic --
  {
    type: 'Anthropic API Key',
    regex: /\b(sk-ant-[A-Za-z0-9\-_]{80,})\b/g,
  },

  // -- OpenAI --
  {
    type: 'OpenAI API Key',
    regex: /\b(sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})\b/g,
  },
  {
    type: 'OpenAI Project Key',
    regex: /\b(sk-proj-[A-Za-z0-9\-_]{40,})\b/g,
  },

  // -- Google --
  {
    type: 'Google API Key',
    regex: /\b(AIza[A-Za-z0-9\-_]{35})\b/g,
  },
  {
    type: 'Google OAuth Client Secret',
    regex: /\b(GOCSPX-[A-Za-z0-9\-_]{28})\b/g,
  },

  // -- Twilio --
  {
    type: 'Twilio API Key',
    regex: /\b(SK[0-9a-f]{32})\b/g,
  },

  // -- SendGrid --
  {
    type: 'SendGrid API Key',
    regex: /\b(SG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43})\b/g,
  },

  // -- Mailgun --
  {
    type: 'Mailgun API Key',
    regex: /\b(key-[A-Za-z0-9]{32})\b/g,
  },

  // -- npm --
  {
    type: 'npm Token',
    regex: /\b(npm_[A-Za-z0-9]{36})\b/g,
  },

  // -- PyPI --
  {
    type: 'PyPI API Token',
    regex: /\b(pypi-[A-Za-z0-9\-_]{50,})\b/g,
  },

  // -- Heroku --
  {
    type: 'Heroku API Key',
    // Require a heroku-related keyword prefix to avoid flagging every UUID
    regex: /(?:heroku[_-]?api[_-]?key|HEROKU[_-]?API[_-]?KEY|heroku[_-]?auth[_-]?token)\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/gi,
  },

  // -- Private keys --
  {
    type: 'Private Key',
    regex: /(-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY(?:\s+BLOCK)?-----)/g,
  },

  // -- JWT --
  {
    type: 'JSON Web Token',
    regex: /\b(eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]+)/g,
  },

  // -- Connection strings --
  {
    type: 'Database Connection String',
    regex: /((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mssql|redis|amqp|amqps):\/\/[^\s'"]+)/g,
  },

  // -- Generic "password" / "secret" / "token" assignments (quoted) --
  {
    type: 'Generic Secret Assignment',
    regex: /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|credentials)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
  },
  // -- Generic assignments (unquoted, e.g. .env files) --
  {
    type: 'Generic Secret Assignment',
    regex: /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|credentials)\s*=\s*([^\s'"]{8,})/gi,
  },
];

// ---------------------------------------------------------------------------
// Known placeholder values that should NOT be flagged
// ---------------------------------------------------------------------------

const PLACEHOLDER_VALUES = new Set([
  // AWS
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  // Generic
  'your-api-key-here',
  'your-secret-key-here',
  'your_api_key_here',
  'your_secret_key_here',
  'INSERT_YOUR_API_KEY',
  'INSERT_YOUR_SECRET_KEY',
  'REPLACE_ME',
  'changeme',
  'password',
  'xxxxxxxx',
  'TODO',
]);

const PLACEHOLDER_PREFIXES = [
  'sk-test-',
  'sk_test_',
  'pk_test_',
  'rk_test_',
  'test_',
  'fake_',
  'dummy_',
  'example_',
  'sample_',
];

// Heroku-style UUIDs that are just zeros or sequential
const ZERO_UUID = /^[0-]{36}$/;
const SEQUENTIAL_UUID = /^01234567-/;

// ---------------------------------------------------------------------------
// Redaction helper
// ---------------------------------------------------------------------------

function redact(value: string): string {
  if (value.length <= 8) return '***';
  const visiblePrefix = Math.min(4, Math.floor(value.length * 0.15));
  const visibleSuffix = Math.min(4, Math.floor(value.length * 0.15));
  const masked = value.length - visiblePrefix - visibleSuffix;
  return `${value.slice(0, visiblePrefix)}${'*'.repeat(Math.min(masked, 20))}${value.slice(-visibleSuffix)}`;
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
    if (/(?:^|[_\-\s])(?:example|placeholder|dummy|fake|your|insert|replace)(?:[_\-\s]|$)/i.test(value)) {
      return true;
    }
  }

  // Repeated 'x' sequences (4+) as obvious placeholders
  if (/x{4,}/i.test(value) && !/[0-9a-wyz]/i.test(value.replace(/x/gi, ''))) {
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
  'key', 'token', 'secret', 'password', 'passwd', 'pwd',
  'api_key', 'api-key', 'apikey',
  'access_key', 'access-key', 'accesskey',
  'auth_token', 'auth-token', 'authtoken',
  'bearer', 'authorization',
  'credential', 'credentials',
  'private_key', 'private-key',
  'client_secret', 'client-secret',
  'signing_key', 'signing-key',
  'encryption_key', 'encryption-key',
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
  (kw) => new RegExp(`(?:^|[^a-z0-9])${kw.replace(/[-]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i'),
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
  while ((m = HEX_TOKEN_RE.exec(text)) !== null) {
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
      type: 'High-Entropy Hex Token',
      startIndex,
      endIndex,
      redactedValue: redact(value),
    });
  }

  // Scan base64 tokens
  BASE64_TOKEN_RE.lastIndex = 0;
  while ((m = BASE64_TOKEN_RE.exec(text)) !== null) {
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
      type: 'High-Entropy Base64 Token',
      startIndex,
      endIndex,
      redactedValue: redact(value),
    });
  }

  return matches;
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
 */
export function scanText(text: string, entropyConfig?: Partial<EntropyConfig>): SecretMatch[] {
  const matches: SecretMatch[] = [];
  // De-duplicate overlapping ranges (a match can fire on multiple patterns)
  const seen = new Set<string>();

  for (const pattern of PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(text)) !== null) {
      // Use first capturing group if present, otherwise full match
      const value = m[1] ?? m[0];
      const startIndex = m.index + (m[0].indexOf(value));
      const endIndex = startIndex + value.length;

      if (isPlaceholder(value)) continue;
      if (isAllowlisted(value)) continue;

      // Extra validation for AWS Secret Keys to avoid hex-string false positives
      if (pattern.type === 'AWS Secret Key' && !isLikelyAwsSecret(value)) continue;

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

  // Sort by position; at same start, wider match first so redaction covers the full span
  matches.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  return matches;
}

/**
 * Replace detected secrets in text with redaction markers.
 * Returns the modified text.
 */
export function redactSecrets(text: string, entropyConfig?: Partial<EntropyConfig>): string {
  const matches = scanText(text, entropyConfig);
  if (matches.length === 0) return text;

  let result = '';
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
    result += `[REDACTED:${match.type}]`;
    lastIndex = match.endIndex;
  }
  result += text.slice(lastIndex);

  return result;
}

// Exported for testing only
export {
  isPlaceholder as _isPlaceholder,
  redact as _redact,
  PATTERNS as _PATTERNS,
  hasSecretContext as _hasSecretContext,
};
