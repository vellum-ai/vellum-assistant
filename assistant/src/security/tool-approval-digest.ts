/**
 * Canonical JSON serialization and deterministic SHA-256 hash for tool
 * approval signatures.
 *
 * Producers (grant creators) and consumers (grant matchers) must use the
 * same serialization to ensure digest equality.  The algorithm:
 *   1. Sort object keys recursively (depth-first).
 *   2. Convert to a canonical JSON string with no whitespace.
 *   3. SHA-256 hash the UTF-8 bytes and return a lowercase hex digest.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Canonical JSON serialization
// ---------------------------------------------------------------------------

/**
 * Recursively sort all object keys and return a deterministic JSON string.
 *
 * Handles nested objects, arrays (element order preserved), and primitive
 * values.  `undefined` values inside objects are omitted (matching
 * JSON.stringify semantics).  `null` is preserved.
 */
export function canonicalJsonSerialize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  // Primitive — number, string, boolean
  return value;
}

// ---------------------------------------------------------------------------
// Digest computation
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic SHA-256 hex digest over the canonical
 * serialization of a tool invocation's name and input.
 *
 * The digest covers `{ toolName, input }` so that two invocations of the
 * same tool with identical (deeply-equal) inputs always produce the same
 * hash, regardless of key ordering in the original input object.
 */
export function computeToolApprovalDigest(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const payload = canonicalJsonSerialize({ input, toolName });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
