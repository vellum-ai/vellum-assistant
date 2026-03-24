/**
 * Ingress secret detection for user messages.
 *
 * Uses a curated subset of high-confidence, prefix-based patterns to
 * deterministically block messages containing real secrets. Unlike
 * `scanText()` from `secret-scanner.ts`, this intentionally excludes
 * broad patterns (JWT, DB URLs, generic `password=`/`secret=` assignments,
 * high-entropy hex/base64, encoded-secret detection) that cause false
 * positives on legitimate user input.
 */

import { getConfig } from "../config/loader.js";
import { isAllowlisted } from "./secret-allowlist.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngressCheckResult {
  blocked: boolean;
  detectedTypes: string[];
  userNotice?: string;
}

// ---------------------------------------------------------------------------
// High-confidence prefix-based patterns
// ---------------------------------------------------------------------------

interface SecretPattern {
  label: string;
  regex: RegExp;
}

const INGRESS_PATTERNS: SecretPattern[] = [
  // AWS
  { label: "AWS Access Key", regex: /AKIA[0-9A-Z]{16}/ },

  // GitHub
  { label: "GitHub Token", regex: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { label: "GitHub PAT", regex: /github_pat_[A-Za-z0-9_]{22,}/ },

  // GitLab
  { label: "GitLab PAT", regex: /glpat-[A-Za-z0-9\-_]{20,}/ },

  // Stripe
  { label: "Stripe Secret Key", regex: /sk_live_[A-Za-z0-9]{24,}/ },
  { label: "Stripe Restricted Key", regex: /rk_live_[A-Za-z0-9]{24,}/ },

  // Slack
  {
    label: "Slack Bot Token",
    regex: /xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/,
  },
  {
    label: "Slack User Token",
    regex: /xoxp-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/,
  },

  // Telegram
  { label: "Telegram Bot Token", regex: /[0-9]{8,10}:[A-Za-z0-9_-]{35}/ },

  // Anthropic
  { label: "Anthropic API Key", regex: /sk-ant-[A-Za-z0-9\-_]{80,}/ },

  // OpenAI
  { label: "OpenAI API Key", regex: /sk-proj-[A-Za-z0-9\-_]{40,}/ },

  // Google
  { label: "Google API Key", regex: /AIza[A-Za-z0-9\-_]{35}/ },
  { label: "Google OAuth Secret", regex: /GOCSPX-[A-Za-z0-9\-_]{28}/ },

  // Twilio
  { label: "Twilio API Key", regex: /SK[0-9a-f]{32}/ },

  // SendGrid
  {
    label: "SendGrid API Key",
    regex: /SG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43}/,
  },

  // npm
  { label: "npm Token", regex: /npm_[A-Za-z0-9]{36}/ },

  // Private keys
  {
    label: "Private Key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
];

// ---------------------------------------------------------------------------
// Placeholder detection (inline — not imported from secret-scanner.ts)
// ---------------------------------------------------------------------------

const KNOWN_PLACEHOLDERS = new Set([
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

const PLACEHOLDER_PREFIXES = [
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
 * Check if the text immediately before a matched value indicates
 * a placeholder context (e.g. "fake_", "test_").
 */
function isPlaceholderContext(preContext: string): boolean {
  const lower = preContext.toLowerCase();
  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (lower.endsWith(prefix)) return true;
  }
  return false;
}

/**
 * Check if a matched value is a placeholder/test value that should not
 * trigger blocking.
 */
function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();

  // Known placeholder values
  if (KNOWN_PLACEHOLDERS.has(lower)) return true;

  // Placeholder prefixes
  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }

  // Repeated characters in the variable portion (e.g. "AKIA" + "X" x 16)
  // Strip known prefixes to isolate the variable part
  const variablePart = value
    .replace(
      /^(?:AKIA|gh[pousr]_|github_pat_|glpat-|sk_live_|rk_live_|xoxb-|xoxp-|sk-ant-|sk-proj-|AIza|GOCSPX-|SK|SG\.|npm_|-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
      "",
    )
    .replace(/[^A-Za-z0-9]/g, "");
  if (variablePart.length >= 8) {
    const firstChar = variablePart[0];
    if (variablePart.split("").every((c) => c === firstChar)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check user message content for high-confidence secret patterns.
 *
 * Returns `{ blocked: true, detectedTypes, userNotice }` if secrets are
 * found and blocking is enabled, otherwise `{ blocked: false }`.
 */
export function checkIngressForSecrets(content: string): IngressCheckResult {
  const config = getConfig();
  const secretDetection = config?.secretDetection;

  // Bail if secret detection config is missing or entirely disabled
  if (!secretDetection?.enabled) {
    return { blocked: false, detectedTypes: [] };
  }

  // Bail if ingress blocking is disabled
  if (!secretDetection.blockIngress) {
    return { blocked: false, detectedTypes: [] };
  }

  const detectedTypes: string[] = [];

  for (const { label, regex } of INGRESS_PATTERNS) {
    // Use a global version to find all matches
    const globalRegex = new RegExp(regex.source, "g");
    let match: RegExpExecArray | null;

    while ((match = globalRegex.exec(content)) !== null) {
      const value = match[0];

      // Skip placeholders and test values (check both the match and
      // a small window before it for placeholder prefixes like "fake_")
      const contextStart = Math.max(0, match.index - 10);
      const preContext = content.slice(contextStart, match.index);
      if (isPlaceholder(value) || isPlaceholderContext(preContext)) continue;

      // Skip user-allowlisted values
      if (isAllowlisted(value)) continue;

      if (!detectedTypes.includes(label)) {
        detectedTypes.push(label);
      }
    }
  }

  if (detectedTypes.length === 0) {
    return { blocked: false, detectedTypes: [] };
  }

  return {
    blocked: true,
    detectedTypes,
    userNotice:
      `Message blocked: detected ` +
      `${detectedTypes.length === 1 ? "a potential credential" : "potential credentials"} ` +
      `(${detectedTypes.join(", ")}). ` +
      `Use the secure credential prompt to provide sensitive values safely.`,
  };
}
