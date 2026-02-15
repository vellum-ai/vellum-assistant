/**
 * Recursive field-level redaction for tool inputs and lifecycle payloads.
 *
 * Replaces values of known-sensitive keys with a redaction placeholder,
 * preserving the overall structure for debugging and audit.
 */

const REDACTION_PLACEHOLDER = '<redacted />';

/** Keys whose values are always redacted (case-insensitive match). */
const SENSITIVE_KEYS = new Set([
  'value',
  'password',
  'token',
  'api_key',
  'apikey',
  'authorization',
  'secret',
  'credentials',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

/**
 * Recursively redact sensitive fields from an object.
 *
 * - Replaces string/number/boolean values of sensitive keys with `<redacted />`
 * - Recurses into nested objects and arrays
 * - Returns a shallow copy — never mutates the original
 */
export function redactSensitiveFields(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj)) {
    if (isSensitiveKey(key) && val != null && typeof val !== 'object') {
      result[key] = REDACTION_PLACEHOLDER;
    } else if (Array.isArray(val)) {
      result[key] = val.map((item) =>
        item != null && typeof item === 'object' && !Array.isArray(item)
          ? redactSensitiveFields(item as Record<string, unknown>)
          : item,
      );
    } else if (val != null && typeof val === 'object') {
      result[key] = redactSensitiveFields(val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }

  return result;
}
