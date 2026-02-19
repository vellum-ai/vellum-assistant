import { getConfig } from '../config/loader.js';

// Emergency/high-risk numbers that should never be called
export const DENIED_NUMBERS = new Set([
  '911', '112', '999', '000', '110', '119',  // Emergency
  '+1911', '+1112',
]);

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
