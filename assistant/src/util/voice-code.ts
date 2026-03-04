/**
 * Cryptographic voice invite code generation and hashing.
 *
 * Generates short numeric codes (default 6 digits) for voice-channel invite
 * redemption. The plaintext code is returned once at creation time and never
 * stored — only its SHA-256 hash is persisted.
 */

import { createHash, randomInt } from "node:crypto";

/**
 * Generate a cryptographically random numeric code of the given length.
 * Uses node:crypto randomInt for uniform distribution.
 */
export function generateVoiceCode(digits: number = 6): string {
  if (digits < 4 || digits > 10) {
    throw new Error(
      `Voice code digit count must be between 4 and 10, got ${digits}`,
    );
  }
  const min = Math.pow(10, digits - 1); // e.g. 100000 for 6 digits
  const max = Math.pow(10, digits); // e.g. 1000000 for 6 digits
  return String(randomInt(min, max));
}

/**
 * SHA-256 hash a voice code for storage comparison.
 */
export function hashVoiceCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
