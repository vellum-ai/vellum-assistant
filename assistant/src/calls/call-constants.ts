// Emergency/high-risk numbers that should never be called
export const DENIED_NUMBERS = new Set([
  '911', '112', '999', '000', '110', '119',  // Emergency
  '+1911', '+1112',
]);

// Call limits
export const MAX_CALL_DURATION_MS = 12 * 60 * 1000; // 12 minutes
export const USER_CONSULTATION_TIMEOUT_MS = 90 * 1000; // 90 seconds
export const SILENCE_TIMEOUT_MS = 30 * 1000; // 30 seconds
