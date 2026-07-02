/**
 * Phone number normalization and validation utilities.
 *
 * Accepts common US and international phone number formats and normalizes
 * them to E.164 before validation, rate-limit lookups, or storage.
 */

// Thin alias over the shared @vellumai/gateway-client invite contract so the
// daemon and the gateway validate voice-invite phone bindings identically.
export { isValidE164 } from "@vellumai/gateway-client";

/**
 * Normalize a phone number string to E.164 format.
 *
 * Strips spaces, dashes, parentheses, and dots, then applies:
 *   - Already starts with `+` and has 10-15 digits -> return as-is
 *   - 10 digits (no +) -> prepend `+1` (assume US)
 *   - 11 digits starting with `1` (no +) -> prepend `+`
 *   - Otherwise -> return null (invalid)
 */
export function normalizePhoneNumber(input: string): string | null {
  // Strip optional trunk-zero notation "(0)" used in international formats
  // like "+44 (0)20 7946 0958" before any other processing.
  const withoutTrunkZero = input.replace(/\(0\)/g, "");

  // Strip formatting characters: spaces, dashes, parentheses, dots
  const stripped = withoutTrunkZero.replace(/[\s\-().]/g, "");

  if (stripped.length === 0) return null;

  if (stripped.startsWith("+")) {
    const digits = stripped.slice(1);
    if (/^\d{10,15}$/.test(digits)) {
      return stripped;
    }
    return null;
  }

  // No + prefix — must be all digits
  if (!/^\d+$/.test(stripped)) return null;

  if (stripped.length === 10) {
    return `+1${stripped}`;
  }

  if (stripped.length === 11 && stripped.startsWith("1")) {
    return `+${stripped}`;
  }

  return null;
}
