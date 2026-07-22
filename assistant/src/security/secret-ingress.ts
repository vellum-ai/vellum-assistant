/**
 * Ingress secret detection for user messages.
 *
 * Consumes `PREFIX_PATTERNS` from `secret-patterns.ts` — the single source
 * of truth for prefix-based secret detection — plus plugin-declared patterns
 * from the runtime registry (`plugin-secret-patterns.ts`), read at call time
 * so registrations apply without a daemon restart.  This module intentionally
 * does NOT import `scanText()` or any entropy/encoding logic to avoid
 * false positives on legitimate user input.
 */

import { getConfig } from "../config/loader.js";
import { memoizePluginPatternDerivation } from "./plugin-secret-patterns.js";
import { isAllowlisted } from "./secret-allowlist.js";
import {
  PREFIX_PATTERNS,
  type SecretPrefixPattern,
} from "./secret-patterns.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngressCheckResult {
  blocked: boolean;
  detectedTypes: string[];
  userNotice?: string;
}

// ---------------------------------------------------------------------------
// Compiled patterns — global variants of the shared prefix patterns
// ---------------------------------------------------------------------------

interface GlobalPattern {
  label: string;
  regex: RegExp;
}

function toGlobalPattern(p: SecretPrefixPattern): GlobalPattern {
  return { label: p.label, regex: new RegExp(p.regex.source, "g") };
}

const STATIC_GLOBAL_PATTERNS: GlobalPattern[] =
  PREFIX_PATTERNS.map(toGlobalPattern);

// Full pattern list, rebuilt only when the plugin-pattern registry changes so
// registrations apply to the next message without a daemon restart.
const getGlobalPatterns = memoizePluginPatternDerivation(
  (pluginPatterns): GlobalPattern[] => [
    ...STATIC_GLOBAL_PATTERNS,
    ...pluginPatterns.map(toGlobalPattern),
  ],
);

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
      /^(?:AKIA|gh[pousr]_|github_pat_|glpat-|sk_live_|rk_live_|xoxb-|xoxp-|xapp-|sk-ant-|sk-proj-|sk-or-v1-|AIza|GOCSPX-|SK|SG\.|npm_|pypi-|key-|lin_api_|ntn_|fw_|pplx-|-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
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
const TOKEN_SHAPE =
  /^[A-Za-z0-9][A-Za-z0-9_-]*[_-](?:tkn|token|key|secret|api|pat|sk|auth)[_-]([A-Za-z0-9_-]{16,})$/i;

const TOKEN_SHAPE_MIN_LENGTH = 20;
const TOKEN_SHAPE_MAX_LENGTH = 512;

/**
 * Check whether the entire message content is a single token-shaped value
 * that should be blocked (no whitespace, plausible length, keyword infix,
 * not a placeholder, not allowlisted).
 */
function isBlockedTokenShapedMessage(content: string): boolean {
  const trimmed = content.trim();
  if (
    trimmed.length < TOKEN_SHAPE_MIN_LENGTH ||
    trimmed.length > TOKEN_SHAPE_MAX_LENGTH ||
    /\s/.test(trimmed)
  ) {
    return false;
  }

  const match = TOKEN_SHAPE.exec(trimmed);
  if (!match) {
    return false;
  }

  // Check both the full value (test_/fake_ prefixes) and the tail after the
  // keyword infix (repeated-char fillers like "xxxxxxxxxxxxxxxx")
  const tail = match[1]!;
  if (isPlaceholder(trimmed) || isPlaceholder(tail)) {
    return false;
  }

  return !isAllowlisted(trimmed);
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

  for (const { label, regex } of getGlobalPatterns()) {
    // Reset lastIndex — the compiled global regexes are shared across calls
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
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

  if (
    detectedTypes.length === 0 &&
    secretDetection.blockTokenShapedMessages &&
    isBlockedTokenShapedMessage(content)
  ) {
    detectedTypes.push("Token-shaped value");
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
