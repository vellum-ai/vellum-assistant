import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify the Vellum-Signature header sent by the Vellum platform.
 *
 * The platform computes: HMAC-SHA256(webhookSecret, rawBody) and sends it as
 *   Vellum-Signature: sha256=<hex-digest>
 *
 * We must compare with a constant-time comparison to avoid timing attacks.
 *
 * This mirrors the WhatsApp webhook signature verification pattern
 * (`X-Hub-Signature-256` header).
 */

const HEADER_NAME = "vellum-signature";

export function verifyEmailWebhookSignature(
  headers: Headers,
  rawBody: string,
  webhookSecret: string,
): boolean {
  const signatureHeader = headers.get(HEADER_NAME);
  if (!signatureHeader || !webhookSecret) return false;

  // Header format: "sha256=<hex-digest>"
  if (!signatureHeader.startsWith("sha256=")) return false;
  const providedHex = signatureHeader.slice(7);

  const expected = createHmac("sha256", webhookSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  // Compare Buffer byte lengths — not string .length — to avoid
  // timingSafeEqual throwing on non-ASCII input where UTF-16 code unit
  // count matches but byte length diverges.
  const providedBuf = Buffer.from(providedHex);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}
