/**
 * Slack reply-callback-URL helpers.
 *
 * The gateway encodes the Slack reply target (thread ts and, for non-threaded
 * DMs, the originating message ts) as query parameters on the `/deliver/slack`
 * callback URL it hands the daemon. These helpers parse those parameters back
 * out at delivery time. (The assistant reply row's thread metadata is stamped
 * separately, from the turn-local `trustContext.sourceThreadId`.)
 */

/**
 * Extract the threadTs from a Slack reply callback URL, if present.
 * The gateway encodes threadTs as a query parameter on the callback URL.
 */
export function extractThreadTsFromCallbackUrl(
  callbackUrl: string | undefined,
): string | null {
  if (!callbackUrl) return null;
  try {
    const url = new URL(callbackUrl);
    return url.searchParams.get("threadTs");
  } catch {
    return null;
  }
}

/**
 * Extract the messageTs from a Slack reply callback URL, if present.
 * The gateway encodes messageTs for non-threaded DMs so the runtime
 * can target the original message for emoji-based indicators.
 */
export function extractMessageTsFromCallbackUrl(
  callbackUrl: string | undefined,
): string | null {
  if (!callbackUrl) return null;
  try {
    const url = new URL(callbackUrl);
    return url.searchParams.get("messageTs");
  } catch {
    return null;
  }
}

/**
 * Whether a reply callback URL targets the Slack delivery endpoint.
 */
export function isSlackDeliveryCallbackUrl(callbackUrl?: string): boolean {
  if (!callbackUrl) return false;
  try {
    return new URL(callbackUrl).pathname.endsWith("/deliver/slack");
  } catch {
    return callbackUrl.endsWith("/deliver/slack");
  }
}
