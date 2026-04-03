import { timingSafeEqual } from "node:crypto";

/**
 * Verify a Vellum email webhook secret.
 *
 * The platform (or any upstream caller) includes the shared secret in
 * the `X-Vellum-Webhook-Secret` header. The gateway compares it against
 * the stored `email:webhook_secret` credential using constant-time
 * comparison to prevent timing attacks.
 *
 * This mirrors the Telegram webhook secret verification pattern
 * (`X-Telegram-Bot-Api-Secret-Token` header).
 */

const HEADER_NAME = "x-vellum-webhook-secret";

export function verifyEmailWebhookSignature(
  headers: Headers,
  _rawBody: string,
  webhookSecret: string,
): boolean {
  const provided = headers.get(HEADER_NAME);
  if (!provided || !webhookSecret) {
    return false;
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(webhookSecret);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
