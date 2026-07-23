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

import {
  isPlaceholderContext,
  isPlaceholderValue,
  TOKEN_SHAPE,
} from "@vellumai/service-contracts/secret-detection";

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
// Token-shape heuristic (whole-message only)
// ---------------------------------------------------------------------------

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
  if (isPlaceholderValue(trimmed) || isPlaceholderValue(tail)) {
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
      if (isPlaceholderValue(value) || isPlaceholderContext(preContext)) {
        continue;
      }

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
