export const BOT_TOKEN_PREFIX = "xoxb-";
export const APP_TOKEN_PREFIX = "xapp-";

/**
 * Shortest plausible Slack token. Real tokens run far longer; this only needs
 * to catch a truncated paste, not to validate the credential.
 */
const TOKEN_MIN_LENGTH = 20;

/**
 * Format-check a pasted Slack token. Returns an error string, or null when the
 * value is acceptable *or* still empty: an untouched field is not an error.
 */
export function validateSlackToken(
  value: string,
  prefix: string,
  label: string,
): string | null {
  const token = value.trim();
  if (!token) {
    return null;
  }
  if (!token.startsWith(prefix)) {
    return `${label} should start with "${prefix}".`;
  }
  if (token.length < TOKEN_MIN_LENGTH) {
    return `${label} looks truncated. Copy the whole value from Slack.`;
  }
  return null;
}
