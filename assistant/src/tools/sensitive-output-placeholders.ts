/**
 * Sensitive output placeholder extraction and substitution.
 *
 * Tool outputs may contain `<vellum-sensitive-output kind="..." value="..." />`
 * directives. This module:
 * 1. Parses and strips those directives from tool output.
 * 2. Replaces any raw sensitive values remaining in the output with stable,
 *    high-uniqueness placeholders so the LLM never sees the real values.
 * 3. Returns bindings (placeholder -> real value) for deterministic
 *    post-generation substitution in the agent loop.
 *
 * Raw sensitive values MUST NOT be logged or emitted in lifecycle events.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SensitiveOutputKind = "invite_code";

export interface SensitiveOutputBinding {
  kind: SensitiveOutputKind;
  placeholder: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Directive regex
// ---------------------------------------------------------------------------

const DIRECTIVE_RE =
  /<vellum-sensitive-output\s+kind="([^"]+)"\s+value="([^"]+)"\s*\/>/g;

// ---------------------------------------------------------------------------
// Placeholder generation
// ---------------------------------------------------------------------------

const KIND_PREFIX: Record<SensitiveOutputKind, string> = {
  invite_code: "VELLUM_ASSISTANT_INVITE_CODE_",
};

const VALID_KINDS = new Set<string>(Object.keys(KIND_PREFIX));

/**
 * Generate an 8-char uppercase base-36 short ID.
 * Provides ~41 bits of entropy - sufficient for intra-request uniqueness.
 */
function generateShortId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function makePlaceholder(kind: SensitiveOutputKind): string {
  return `${KIND_PREFIX[kind]}${generateShortId()}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  sanitizedContent: string;
  bindings: SensitiveOutputBinding[];
}

/**
 * Extract `<vellum-sensitive-output>` directives from tool output content,
 * strip them, replace any remaining occurrences of the raw sensitive values
 * with placeholders, and return the bindings for downstream substitution.
 *
 * Guarantees:
 * - Directives are fully removed from the returned content.
 * - Empty values are silently dropped.
 * - Duplicate values produce a single binding (same placeholder).
 * - Unknown kinds are silently ignored.
 */
export function extractAndSanitize(content: string): SanitizeResult {
  const bindings: SensitiveOutputBinding[] = [];
  const seenValues = new Map<string, SensitiveOutputBinding>();

  // Step 1: parse directives
  // Reset lastIndex for safety since the regex is global
  DIRECTIVE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DIRECTIVE_RE.exec(content)) !== null) {
    const kind = match[1];
    const value = match[2];

    if (!value || value.trim().length === 0) continue;
    if (!VALID_KINDS.has(kind)) continue;

    const typedKind = kind as SensitiveOutputKind;
    if (!seenValues.has(value)) {
      const binding: SensitiveOutputBinding = {
        kind: typedKind,
        placeholder: makePlaceholder(typedKind),
        value,
      };
      bindings.push(binding);
      seenValues.set(value, binding);
    }
  }

  if (bindings.length === 0) {
    return { sanitizedContent: content, bindings: [] };
  }

  // Step 2: strip directive tags
  let sanitized = content.replace(DIRECTIVE_RE, "");

  // Step 3: replace raw values with placeholders throughout remaining content
  for (const binding of bindings) {
    sanitized = sanitized.split(binding.value).join(binding.placeholder);
  }

  return { sanitizedContent: sanitized, bindings };
}

/**
 * Apply placeholder->value substitution to a text string.
 * Used by the agent loop to resolve placeholders in streamed deltas
 * and final message content.
 */
export function applySubstitutions(
  text: string,
  substitutionMap: ReadonlyMap<string, string>,
): string {
  if (substitutionMap.size === 0) return text;

  let result = text;
  for (const [placeholder, value] of substitutionMap) {
    result = result.split(placeholder).join(value);
  }
  return result;
}

/**
 * Chunk-safe substitution for streaming text deltas.
 *
 * Because a placeholder like `VELLUM_ASSISTANT_INVITE_CODE_AB12CD34` may be
 * split across consecutive streamed chunks, this function buffers a trailing
 * segment that could be the start of an incomplete placeholder and returns it
 * as `pending`. The caller must prepend `pending` to the next chunk.
 *
 * Returns `{ emit, pending }`:
 * - `emit`: text safe to send to the client (all complete placeholders resolved).
 * - `pending`: trailing text that might be an incomplete placeholder prefix.
 */
export function applyStreamingSubstitution(
  text: string,
  substitutionMap: ReadonlyMap<string, string>,
): { emit: string; pending: string } {
  if (substitutionMap.size === 0) {
    return { emit: text, pending: "" };
  }

  // First, resolve any complete placeholders
  let resolved = text;
  for (const [placeholder, value] of substitutionMap) {
    resolved = resolved.split(placeholder).join(value);
  }

  // Check if the tail of resolved text could be an incomplete placeholder prefix.
  // All current placeholders start with "VELLUM_ASSISTANT_".
  const PREFIX = "VELLUM_ASSISTANT_";
  const minSuffixLen = 1; // At minimum, one char of the prefix

  // Walk backwards from the end to find a trailing partial match of any placeholder prefix
  let pendingStart = resolved.length;
  for (
    let i = Math.max(
      0,
      resolved.length - getMaxPlaceholderLength(substitutionMap),
    );
    i < resolved.length;
    i++
  ) {
    const tail = resolved.slice(i);
    // Check if any placeholder starts with this tail
    if (tail.length >= minSuffixLen && PREFIX.startsWith(tail)) {
      pendingStart = i;
      break;
    }
    // Also check if any full placeholder key starts with this tail
    for (const placeholder of substitutionMap.keys()) {
      if (placeholder.startsWith(tail) && tail.length < placeholder.length) {
        pendingStart = i;
        break;
      }
    }
    if (pendingStart !== resolved.length) break;
  }

  return {
    emit: resolved.slice(0, pendingStart),
    pending: resolved.slice(pendingStart),
  };
}

function getMaxPlaceholderLength(map: ReadonlyMap<string, string>): number {
  let max = 0;
  for (const key of map.keys()) {
    if (key.length > max) max = key.length;
  }
  return max;
}
