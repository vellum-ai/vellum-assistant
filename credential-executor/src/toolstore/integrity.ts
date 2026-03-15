/**
 * Bundle integrity verification.
 *
 * Provides SHA-256 digest computation and verification for secure command
 * bundles. Digests are computed over the raw bundle bytes and compared
 * against the expected digest declared in the toolstore manifest.
 *
 * All digests are lowercase hex-encoded SHA-256 hashes (64 characters).
 */

import { createHash, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Digest computation
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hex digest of arbitrary bytes.
 *
 * Returns a lowercase 64-character hex string.
 */
export function computeDigest(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Digest verification
// ---------------------------------------------------------------------------

export interface DigestVerificationResult {
  /** Whether the computed digest matches the expected digest. */
  valid: boolean;
  /** The computed digest (always present). */
  computedDigest: string;
  /** The expected digest (always present). */
  expectedDigest: string;
  /** Human-readable error message when invalid (undefined when valid). */
  error?: string;
}

/**
 * Verify that the SHA-256 digest of `data` matches `expectedDigest`.
 *
 * Uses constant-time comparison via `timingSafeEqual` to prevent
 * timing side-channel attacks on digest values.
 */
export function verifyDigest(
  data: Buffer | Uint8Array,
  expectedDigest: string,
): DigestVerificationResult {
  const computedDigest = computeDigest(data);

  // Use timing-safe comparison to prevent timing attacks
  const computedBuf = Buffer.from(computedDigest, "hex");
  const expectedBuf = Buffer.from(expectedDigest, "hex");

  // If the expected digest is not valid hex (wrong length), fail
  if (computedBuf.length !== expectedBuf.length || expectedBuf.length !== 32) {
    return {
      valid: false,
      computedDigest,
      expectedDigest,
      error: `Digest mismatch: expected "${expectedDigest}" but computed "${computedDigest}". ` +
        `The bundle contents do not match the declared digest.`,
    };
  }

  const match = safeTimingEqual(computedBuf, expectedBuf);

  if (!match) {
    return {
      valid: false,
      computedDigest,
      expectedDigest,
      error: `Digest mismatch: expected "${expectedDigest}" but computed "${computedDigest}". ` +
        `The bundle contents do not match the declared digest.`,
    };
  }

  return {
    valid: true,
    computedDigest,
    expectedDigest,
  };
}

/**
 * Constant-time buffer comparison. Wraps `crypto.timingSafeEqual`
 * with a length guard (timingSafeEqual throws on length mismatch).
 */
function safeTimingEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
