import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify the X-Hub-Signature-256 header sent by Meta's webhook delivery.
 *
 * Meta computes: HMAC-SHA256(appSecret, rawBody) and sends it as
 *   X-Hub-Signature-256: sha256=<hex-digest>
 *
 * We must compare with a constant-time comparison to avoid timing attacks.
 */
export function verifyWhatsAppWebhookSignature(
  headers: Headers,
  rawBody: string,
  appSecret: string,
): boolean {
  const signatureHeader = headers.get("x-hub-signature-256");
  if (!signatureHeader || !appSecret) return false;

  // Header format: "sha256=<hex-digest>"
  if (!signatureHeader.startsWith("sha256=")) return false;
  const providedHex = signatureHeader.slice(7);

  const expected = createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  // Lengths must match before timingSafeEqual to avoid Buffer size mismatch error
  if (providedHex.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(providedHex), Buffer.from(expected));
}
