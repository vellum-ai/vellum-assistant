import { timingSafeEqual } from "crypto";

export function verifyWebhookSecret(
  headers: Headers,
  expectedSecret: string,
): boolean {
  const provided = headers.get("x-telegram-bot-api-secret-token");
  if (!provided || !expectedSecret) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
