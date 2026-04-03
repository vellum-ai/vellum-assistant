import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an AgentMail/Svix webhook signature.
 *
 * AgentMail uses Svix for webhook delivery. Svix signs payloads using
 * HMAC-SHA256 and sends three headers:
 *   - svix-id:        unique message ID
 *   - svix-timestamp: Unix timestamp (seconds)
 *   - svix-signature: space-separated list of versioned signatures
 *                     e.g. "v1,<base64-digest> v1,<base64-digest>"
 *
 * The signed content is: `${svix-id}.${svix-timestamp}.${rawBody}`
 *
 * The webhook secret from Svix starts with "whsec_" followed by the
 * base64-encoded key. We strip the prefix before computing the HMAC.
 *
 * We also reject timestamps older than TOLERANCE_SECONDS to prevent
 * replay attacks.
 */

const TOLERANCE_SECONDS = 300; // 5 minutes
const SVIX_SECRET_PREFIX = "whsec_";

export function verifyEmailWebhookSignature(
  headers: Headers,
  rawBody: string,
  webhookSecret: string,
): boolean {
  const msgId = headers.get("svix-id");
  const msgTimestamp = headers.get("svix-timestamp");
  const msgSignature = headers.get("svix-signature");

  if (!msgId || !msgTimestamp || !msgSignature || !webhookSecret) {
    return false;
  }

  // Verify timestamp is within tolerance
  const ts = parseInt(msgTimestamp, 10);
  if (Number.isNaN(ts)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) {
    return false;
  }

  // Derive the signing key
  const secretBytes = webhookSecret.startsWith(SVIX_SECRET_PREFIX)
    ? Buffer.from(webhookSecret.slice(SVIX_SECRET_PREFIX.length), "base64")
    : Buffer.from(webhookSecret, "base64");

  // Compute expected signature
  const signedContent = `${msgId}.${msgTimestamp}.${rawBody}`;
  const expectedSignature = createHmac("sha256", secretBytes)
    .update(signedContent, "utf8")
    .digest("base64");

  // Svix sends space-separated versioned signatures.
  // Each entry is "v1,<base64-digest>". We only support v1.
  const signatures = msgSignature.split(" ");
  for (const sig of signatures) {
    const trimmed = sig.trim();
    if (!trimmed.startsWith("v1,")) continue;

    const sigValue = trimmed.slice(3);
    if (!sigValue) continue;

    try {
      const a = Buffer.from(sigValue);
      const b = Buffer.from(expectedSignature);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return true;
      }
    } catch {
      // Buffer length mismatch — continue to next signature
    }
  }

  return false;
}
