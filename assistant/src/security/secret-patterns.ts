/**
 * Shared prefix-based secret patterns — the single source of truth.
 *
 * Ingress blocking, tool output scanning, and log redaction all consume
 * this list.  When adding a new integration, add its API key pattern here.
 *
 * This module is intentionally data-only: no imports, no entropy logic,
 * no config — safe for hot-path consumers like log serializers.
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
export const PREFIX_PATTERNS: SecretPrefixPattern[] = [
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

  // -- Private keys --
  {
    label: "Private Key",
    regex:
      /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY(?:\s+BLOCK)?-----/,
  },

  // -- Linear --
  { label: "Linear API Key", regex: /lin_api_[A-Za-z0-9]{32,}/ },

  // -- Notion --
  { label: "Notion Integration Token", regex: /ntn_[A-Za-z0-9]{40,}/ },

  // -- OpenRouter --
  { label: "OpenRouter API Key", regex: /sk-or-v1-[A-Za-z0-9\-_]{40,}/ },

  // -- Fireworks --
  { label: "Fireworks API Key", regex: /fw_[A-Za-z0-9]{32,}/ },

  // -- Perplexity --
  { label: "Perplexity API Key", regex: /pplx-[A-Za-z0-9]{40,}/ },
];
