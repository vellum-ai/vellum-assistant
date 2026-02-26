/**
 * Phone number normalization and validation utilities.
 *
 * Accepts common US and international phone number formats and normalizes
 * them to E.164 before validation, rate-limit lookups, or storage.
 */

/**
 * Basic E.164 phone number validation: starts with +, followed by 10-15 digits.
 */
export function isValidE164(phone: string): boolean {
  return /^\+\d{10,15}$/.test(phone);
}

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
  // Strip formatting characters: spaces, dashes, parentheses, dots
  const stripped = input.replace(/[\s\-().]/g, '');

  if (stripped.length === 0) return null;

  if (stripped.startsWith('+')) {
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

  if (stripped.length === 11 && stripped.startsWith('1')) {
    return `+${stripped}`;
  }

  return null;
}
