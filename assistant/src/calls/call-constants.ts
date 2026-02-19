import { getConfig } from '../config/loader.js';

// Emergency/high-risk numbers that should never be called
export const DENIED_NUMBERS = new Set([
  '911', '112', '999', '000', '110', '119',
]);

/**
 * Check whether a phone number is a denied emergency number.
 *
 * Normalizes E.164 variants by stripping the leading '+' and then checking
 * whether the resulting digit string exactly matches a denied number or could
 * be a country-code-prefixed emergency number (e.g. +1911, +44999, +61000).
 * Country codes are 1–3 digits, so we try every valid split.
 */
export function isDeniedNumber(phoneNumber: string): boolean {
  // Strip leading '+' to get a digits-only string
  const digits = phoneNumber.startsWith('+') ? phoneNumber.slice(1) : phoneNumber;

  // Exact match (covers bare short codes like "911", "112")
  if (DENIED_NUMBERS.has(digits)) return true;

  // Try splitting off 1-, 2-, or 3-digit country codes and check if the
  // remainder is a denied number. This catches patterns like +1911, +44999.
  for (let ccLen = 1; ccLen <= 3; ccLen++) {
    if (digits.length > ccLen) {
      const remainder = digits.slice(ccLen);
      if (DENIED_NUMBERS.has(remainder)) return true;
    }
  }

  return false;
}

// Call limits — backed by config with hardcoded fallbacks
export function getMaxCallDurationMs(): number {
  return getConfig().calls.maxDurationSeconds * 1000;
}

export function getUserConsultationTimeoutMs(): number {
  return getConfig().calls.userConsultTimeoutSeconds * 1000;
}

export const SILENCE_TIMEOUT_MS = 30 * 1000; // 30 seconds

// Legacy named exports for backward compatibility (use functions above for config-backed values)
export const MAX_CALL_DURATION_MS = 3600 * 1000; // fallback default; prefer getMaxCallDurationMs()
export const USER_CONSULTATION_TIMEOUT_MS = 120 * 1000; // fallback default; prefer getUserConsultationTimeoutMs()
