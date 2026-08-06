/**
 * Telegram bot tokens are `<bot id>:<secret>`: a numeric id, a colon, then a
 * secret of URL-safe characters. BotFather hands the whole thing over on one
 * line, so a paste that loses the id or the colon is a partial selection.
 */
const TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]+$/;

/**
 * Shortest plausible secret half. Real ones run to about 35 characters; this
 * only needs to catch a truncated paste, not to validate the credential.
 */
const SECRET_MIN_LENGTH = 25;

/**
 * Format-check a pasted Telegram bot token. Returns an error string, or null
 * when the value is acceptable *or* still empty: an untouched field is not an
 * error.
 */
export function validateTelegramToken(value: string): string | null {
  const token = value.trim();
  if (!token) {
    return null;
  }
  if (!TOKEN_SHAPE.test(token)) {
    return 'Bot token should look like "123456:ABC-DEF...". Copy the whole line from BotFather.';
  }
  const secret = token.slice(token.indexOf(":") + 1);
  if (secret.length < SECRET_MIN_LENGTH) {
    return "Bot token looks truncated. Copy the whole line from BotFather.";
  }
  return null;
}
