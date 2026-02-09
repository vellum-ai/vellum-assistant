/**
 * Secret scanner — detects leaked secrets (API keys, tokens, passwords,
 * private keys, connection strings) in arbitrary text.  Patterns are curated
 * from gitleaks and detect-secrets.
 */

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
    regex: /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g,
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

  // -- Generic "password" / "secret" / "token" assignments --
  {
    type: 'Generic Secret Assignment',
    regex: /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|credentials)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
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
    while ((m = pattern.regex.exec(text)) !== null) {
      // Use first capturing group if present, otherwise full match
      const value = m[1] ?? m[0];
      const startIndex = m.index + (m[0].indexOf(value));
      const endIndex = startIndex + value.length;

      if (isPlaceholder(value)) continue;

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

  // Sort by position
  matches.sort((a, b) => a.startIndex - b.startIndex);
  return matches;
}

/**
 * Replace detected secrets in text with redaction markers.
 * Returns the modified text.
 */
export function redactSecrets(text: string): string {
  const matches = scanText(text);
  if (matches.length === 0) return text;

  let result = '';
  let lastIndex = 0;

  for (const match of matches) {
    result += text.slice(lastIndex, match.startIndex);
    result += `[REDACTED:${match.type}]`;
    lastIndex = match.endIndex;
  }
  result += text.slice(lastIndex);

  return result;
}

// Exported for testing only
export { isPlaceholder as _isPlaceholder, redact as _redact, PATTERNS as _PATTERNS };
