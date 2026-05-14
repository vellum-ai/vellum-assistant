import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Maximum age (in seconds) for the `svix-timestamp` header before we reject
 * the webhook as too old. Matches Svix's default tolerance of 5 minutes.
 */
export const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verify a Resend/Svix webhook signature.
 *
 * Svix signs webhooks with HMAC-SHA256 using the base64-decoded portion
 * of the webhook secret (everything after the `whsec_` prefix).
 *
 * The signed content is: `${svix-id}.${svix-timestamp}.${rawBody}`
 *
 * The `svix-signature` header contains one or more space-delimited
 * versioned signatures (e.g. `v1,<base64>`). We verify against all `v1`
 * entries and succeed if any match.
 *
 * Returns `false` when:
 *   - any of `svix-id`, `svix-timestamp`, `svix-signature` headers are absent
 *   - `secret` is empty
 *   - the timestamp is not numeric, or is outside the ±5 min replay window
 *   - no `v1` entry in the header matches the computed digest
 */
export function verifySvixSignature(
  headers: Headers,
  rawBody: string,
  secret: string,
): boolean {
  const msgId = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatureHeader = headers.get("svix-signature");

  if (!msgId || !timestamp || !signatureHeader || !secret) return false;

  // Reject stale timestamps to prevent replay attacks
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SVIX_TIMESTAMP_TOLERANCE_SECONDS) return false;

  // Extract the raw key bytes — secret may have a `whsec_` prefix
  const secretPart = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(secretPart, "base64");

  // Compute expected signature
  const signedContent = `${msgId}.${timestamp}.${rawBody}`;
  const expectedSig = createHmac("sha256", secretBytes)
    .update(signedContent, "utf8")
    .digest("base64");

  // svix-signature may contain multiple space-delimited entries like
  // "v1,<base64> v1,<base64> v2,<base64>"
  const signatures = signatureHeader.split(" ");
  for (const entry of signatures) {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) continue;

    const expectedBuf = Buffer.from(expectedSig);
    const providedBuf = Buffer.from(sig);
    if (expectedBuf.length !== providedBuf.length) continue;

    if (timingSafeEqual(expectedBuf, providedBuf)) return true;
  }

  return false;
}
