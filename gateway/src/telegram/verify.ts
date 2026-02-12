export function verifyWebhookSecret(
  headers: Headers,
  expectedSecret: string,
): boolean {
  const provided = headers.get("x-telegram-bot-api-secret-token");
  if (!provided || !expectedSecret) {
    return false;
  }
  return provided === expectedSecret;
}
